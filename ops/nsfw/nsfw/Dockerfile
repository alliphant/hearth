# NSFW MobileNetV2 classifier — tiny CPU FastAPI sidecar.
# Model: GantMan/nsfw_model MobileNetV2 (224x224), 5-class. MIT.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl && rm -rf /var/lib/apt/lists/*
# tensorflow-cpu keeps the image small (no CUDA); pillow for decode.
# 2.15.* is LOAD-BEARING, not a floor: it's the last Keras-2 TensorFlow, and the
# GantMan SavedModel is pre-TF-2.5 — it loads via the Keras compat path that
# Keras 3 (TF 2.16+) removed. Do not bump past 2.15 without re-validating the load.
RUN pip install --no-cache-dir \
    "tensorflow-cpu==2.15.*" fastapi "uvicorn[standard]" python-multipart pillow numpy
COPY app.py /app/app.py
WORKDIR /app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8094"]
