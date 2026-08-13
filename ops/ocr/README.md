# Cordelia OCR fallback

PaddleOCR served by a small FastAPI sidecar. CPU-only — the visual
pipeline only reaches for this connector when iOS-side Vision OCR was
empty (non-English document, the device failed, or the upload didn't
come from iOS).

## Endpoint

```
POST /ocr
  multipart:
    image:    <bytes>            (required)
    language: <lang_code>        (optional; e.g. "en", "es", "fr")

→ 200 application/json
  {
    "text": "<full extracted text, newline-joined>",
    "mean_confidence": 0.0-1.0,
    "blocks": [
      { "text": "...", "bbox": [x1, y1, x2, y2], "confidence": 0.0-1.0 }
    ]
  }
```

Hearth's connector ([src/connectors/ocr.ts](../../src/connectors/ocr.ts))
treats absence of `text` as a soft failure: the classifier proceeds
with whatever signal it already has from VL / user note / iOS hint.

## Bring up

```bash
cd ops/ocr
docker compose up -d --build
curl -fsS http://localhost:8090/health
```

A simple test:

```bash
curl -F image=@some-receipt.jpg http://localhost:8090/ocr | jq .
```

## paddleocr/ sidecar contents

The Dockerfile + FastAPI app are intentionally TINY — under 50 lines.
A reference implementation:

```dockerfile
# ops/ocr/paddleocr/Dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir paddleocr fastapi "uvicorn[standard]" python-multipart pillow
COPY app.py /app/app.py
WORKDIR /app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
```

```python
# ops/ocr/paddleocr/app.py
from io import BytesIO
from fastapi import FastAPI, File, UploadFile, Form
from paddleocr import PaddleOCR
from PIL import Image

app = FastAPI()
_engines: dict[str, PaddleOCR] = {}

def engine_for(lang: str) -> PaddleOCR:
    if lang not in _engines:
        _engines[lang] = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
    return _engines[lang]

@app.get("/health")
def health(): return {"ok": True}

@app.post("/ocr")
async def ocr(image: UploadFile = File(...), language: str = Form("en")):
    raw = await image.read()
    img = Image.open(BytesIO(raw)).convert("RGB")
    result = engine_for(language).ocr(np.array(img), cls=True)
    blocks = []
    for line in (result[0] or []):
        bbox, (text, conf) = line
        flat = [bbox[0][0], bbox[0][1], bbox[2][0], bbox[2][1]]
        blocks.append({"text": text, "bbox": flat, "confidence": float(conf)})
    text = "\n".join(b["text"] for b in blocks)
    mean = sum(b["confidence"] for b in blocks) / len(blocks) if blocks else 0.0
    return {"text": text, "mean_confidence": mean, "blocks": blocks}
```

A future revision should batch-process multi-page PDFs / multi-image
captures, but in v1 every capture is single-image.

## Wire it to Hearth

```
HEARTH_OCR_BASE_URL=http://localhost:8090
HEARTH_OCR_FALLBACK_ENABLED=1
```

Restart the orchestrator. The visual-pipeline smoke mocks the
transport, so it passes regardless; live verification can be done
with a curl against the endpoint above.
