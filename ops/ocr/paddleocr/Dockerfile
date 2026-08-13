# PaddleOCR sidecar — CPU fallback for the Cordelia/Linda visual pipeline.
# Tiny FastAPI wrapper over PaddleOCR. Contract: POST /ocr (multipart
# image[, language]) -> { text, mean_confidence, blocks } (see ../README.md).
#
# Versions are PINNED: paddleocr 2.7.x + paddlepaddle 2.6.x (CPU) is the
# combo that matches the 2.x API this app uses (use_angle_cls, show_log,
# .ocr(img, cls=True), result[0] = [[bbox,(text,conf)], ...]). numpy is held
# <2 because paddlepaddle 2.6 isn't numpy-2 compatible.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 curl && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "numpy<2" \
    paddlepaddle==2.6.2 \
    paddleocr==2.7.3 \
    fastapi "uvicorn[standard]" python-multipart pillow

COPY app.py /app/app.py
WORKDIR /app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
