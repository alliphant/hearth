"""
NSFW MobileNetV2 classifier sidecar (Media Archive).

Loads the GantMan/nsfw_model MobileNetV2 (224x224) model once and grades an
uploaded image into 5 classes. CPU-only, tiny, stateless.

Contract (see ops/nsfw/README.md):
    POST /classify  multipart {image: bytes}
      -> { drawings, hentai, neutral, porn, sexy }   (5 floats, ~sum 1)
    GET  /health    -> { ok, model_loaded }

The five classes come straight from the model; the Hearth connector
(src/connectors/nsfw.ts) does the SFW/NSFW/uncertain aggregation + thresholds,
so this stays a dumb, fast classifier that names no one.

We load the **SavedModel directory** (`mobilenet_v2_140_224/`), NOT the bundled
`saved_model.h5`: the .h5 is a `hub.KerasLayer` wrapper and won't deserialize
without `tensorflow_hub`, whereas the SavedModel has the ops baked into its
graph and loads standalone as a Sequential model. The GantMan model was saved
pre-TF-2.5, so it loads via the Keras compatibility path — which is why the
Dockerfile pins the last Keras-2 TensorFlow (2.15); Keras 3 (TF 2.16+) drops it.
"""
import io
import os

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image

# GantMan class order for the MobileNetV2 checkpoint (from class_labels.txt).
CLASSES = ["drawings", "hentai", "neutral", "porn", "sexy"]
MODEL_PATH = os.environ.get("NSFW_MODEL_PATH", "/model/mobilenet_v2_140_224")
DIM = 224

app = FastAPI()
_model = None


def _load():
    global _model
    if _model is None:
        # Imported lazily so /health answers even before TF finishes loading.
        import tensorflow as tf

        _model = tf.keras.models.load_model(MODEL_PATH, compile=False)
    return _model


@app.on_event("startup")
def _warm():
    try:
        _load()
    except Exception as exc:  # noqa: BLE001 — health still reports model_loaded=false
        print(f"[nsfw] model load deferred: {exc}", flush=True)


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": _model is not None}


@app.post("/classify")
async def classify(image: UploadFile = File(...)):
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty image")
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB").resize((DIM, DIM))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"decode failed: {exc}")
    arr = (np.asarray(img, dtype=np.float32) / 255.0)[None, ...]
    try:
        # Direct forward pass (single image) — no tf.function retrace spam that
        # `.predict()` logs on tiny batches; ~tens of ms on CPU.
        preds = np.asarray(_load()(arr, training=False))[0]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"model unavailable: {exc}")
    return {cls: float(preds[i]) for i, cls in enumerate(CLASSES)}
