# Hearth Voice Coordinator — aioesphomeapi client for the Satellite1.
#
# Runs as a Docker container on the LLM host with HOST networking (it needs LAN
# reach to the device at 192.168.0.29:6053, parakeet :8093, forza :8023, and
# the orchestrator at 127.0.0.1:7700). See the compose snippet below the file
# and integrations/voice-coordinator/README.md.
#
# Build context is the package dir:
#   docker build -t hearth-voice-coordinator integrations/voice-coordinator
#
# DO NOT DEPLOY from this build pass — Phase 0 ships the image + compose, the
# device handoff (Phase 4) is a maintenance-window step.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Deps first for layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# The package, imported as integrations.voice_coordinator so the module path
# matches the repo layout (and the sentence-splitter / state machine can be
# unit-tested the same way in CI).
COPY . /app/integrations/voice_coordinator/
RUN touch /app/integrations/__init__.py

# Bake the Silero v5 VAD model (~2 MB) into the image — it's not vendored in git
# (binary). vad.default_model_path() resolves to this path. Override at runtime
# with HEARTH_VC_VAD_MODEL if you mount a different copy. (urllib, not curl —
# the slim image has no curl.)
RUN python -c "import urllib.request,os; d='/app/integrations/voice_coordinator/models'; os.makedirs(d,exist_ok=True); urllib.request.urlretrieve(os.environ.get('SILERO_VAD_URL','https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx'), d+'/silero_vad.onnx'); print('vad model:', os.path.getsize(d+'/silero_vad.onnx'), 'bytes')"

# Health endpoint (host network → reachable at :8094 on the LLM host).
EXPOSE 8094

# Config is all env (see config.py). The PSK + bearer come from the compose
# env_file; nothing secret is baked into the image.
CMD ["python", "-m", "integrations.voice_coordinator.coordinator"]
