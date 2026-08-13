# PaddleOCR sidecar — CPU fallback for the visual pipeline.
#
# Contract (src/connectors/ocr.ts + ../README.md):
#   POST /ocr   multipart { image: bytes, language?: str }
#   -> 200 { "text": str, "mean_confidence": 0.0-1.0,
#            "blocks": [ {text, bbox:[x1,y1,x2,y2], confidence}, ... ] }
#   GET  /health -> { "ok": true }
#
# CPU-only. Engines are cached per language. PaddleOCR downloads its
# det/rec/cls models on first init; we pre-warm "en" at startup (best
# effort) so the first real request isn't slow and model-download issues
# surface at boot rather than mid-turn.

from io import BytesIO

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from paddleocr import PaddleOCR
from PIL import Image

app = FastAPI()
_engines: dict[str, PaddleOCR] = {}


def engine_for(lang: str) -> PaddleOCR:
    lang = (lang or "en").strip() or "en"
    if lang not in _engines:
        try:
            _engines[lang] = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
        except TypeError:
            # Older/newer builds may not accept show_log; fall back.
            _engines[lang] = PaddleOCR(use_angle_cls=True, lang=lang)
    return _engines[lang]


@app.on_event("startup")
def _prewarm() -> None:
    # Best effort: download + load the English model so the first /ocr is
    # fast. A transient failure here must not crash the container — the
    # engine loads lazily on the first request instead.
    try:
        engine_for("en")
    except Exception as exc:  # noqa: BLE001
        print(f"[ocr] prewarm skipped: {exc}", flush=True)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/ocr")
async def ocr(image: UploadFile = File(...), language: str = Form("en")) -> dict:
    raw = await image.read()
    img = Image.open(BytesIO(raw)).convert("RGB")
    arr = np.array(img)

    result = engine_for(language).ocr(arr, cls=True)

    blocks = []
    # paddleocr 2.7 returns [ [ [bbox, (text, conf)], ... ] ]; the inner
    # list can be None when nothing is detected.
    lines = result[0] if result and len(result) > 0 else None
    for line in lines or []:
        try:
            bbox, (text, conf) = line
            flat = [
                float(bbox[0][0]),
                float(bbox[0][1]),
                float(bbox[2][0]),
                float(bbox[2][1]),
            ]
            blocks.append(
                {"text": text, "bbox": flat, "confidence": float(conf)}
            )
        except (ValueError, TypeError, IndexError):
            continue

    text = "\n".join(b["text"] for b in blocks)
    mean = sum(b["confidence"] for b in blocks) / len(blocks) if blocks else 0.0
    return {"text": text, "mean_confidence": mean, "blocks": blocks}
