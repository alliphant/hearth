# NSFW classifier sidecar (Media Archive)

A tiny CPU-only FastAPI sidecar that grades an image sexual-vs-not for the
media-archival pipeline's SFW/NSFW cordon. Purpose-built and fast (~tens of
ms/image on CPU) so it never touches — or waits on — the slow GB10 VL. Mirrors
the OCR sidecar ([ops/ocr/](../ocr/)).

Model: **[GantMan/nsfw_model](https://github.com/GantMan/nsfw_model)** (MIT) —
the light **MobileNetV2 (224×224)** variant, 5 classes. We ship the **SavedModel
directory** from the `1.1.0` release ZIP (`fetch-model.sh` grabs it). `nsfwjs`
(the TF.js sibling — same weights) is an acceptable Node alternative; keep the
same `/classify` contract.

> **Why the SavedModel dir, not the `.h5`:** the release bundle's `saved_model.h5`
> is a `hub.KerasLayer` wrapper that won't deserialize without `tensorflow_hub`,
> and the once-linked S3 `.h5` (`nsfw_mobilenet2.224x224.h5`) now 403s. The
> SavedModel `.pb` + `variables/` has the ops baked into its graph and loads
> standalone as a Sequential model. It's a **pre-TF-2.5** SavedModel, so it needs
> the Keras-2 compat path — hence the Dockerfile's `tensorflow-cpu==2.15.*` pin
> (Keras 3 / TF 2.16+ removed it). Don't bump TF without re-validating the load.

> **Why a dedicated model, not the VL:** the vision model is *describe-not-
> recognize* — it fabricates fine identities at high confidence (see the
> `project-vl-camera-capability-envelope` memory). A scene-is-sexual grade is a
> classification task a purpose-built model does reliably and cheaply, and it
> **names no one** — the artist/creator always comes from metadata, never a
> vision model.

## Endpoint

```
POST /classify
  multipart:
    image: <bytes>            (required)

→ 200 application/json
  {
    "drawings": 0.0-1.0,      # SFW art / anime
    "hentai":   0.0-1.0,      # pornographic drawings  (NSFW)
    "neutral":  0.0-1.0,      # SFW
    "porn":     0.0-1.0,      # explicit               (NSFW)
    "sexy":     0.0-1.0       # suggestive             (borderline)
  }

GET /health → 200 { "ok": true, "model_loaded": true }
```

The Hearth connector ([src/connectors/nsfw.ts](../../src/connectors/nsfw.ts))
aggregates the five classes into a `SFW | NSFW | uncertain` verdict
(`HEARTH_NSFW_HIGH` / `HEARTH_NSFW_LOW` thresholds) across the thumbnail + N
sampled keyframes, and **fails closed to owner-only** when the sidecar is
unreachable — a missed-NSFW-into-the-household is the unacceptable failure.

## Network isolation — no phone-home possible (load-bearing)

This classifier runs on an **`internal: true` Docker network with NO gateway**, so
it has **zero outbound connectivity** — it physically cannot reach the internet.
It never needs to: the MobileNetV2 model is a LOCAL, read-only bind-mount and
inference is offline. TensorFlow's transitive deps (`tensorflow-io-gcs-filesystem`,
`requests`, `grpcio`) are present but never invoked, and can no longer phone home
even if a future code path tried. The orchestrator reaches the sidecar because it
**also joins** `hearth-nsfw-net`; the sidecar is on that network **only**.

Verify the isolation any time:

```bash
docker exec hearth-nsfw curl -m5 https://example.com   # MUST fail (no route)
docker exec hearth-orchestrator curl -fsS http://hearth-nsfw:8094/health  # MUST succeed
```

## Bring up

```bash
# ONE-TIME: the internal, gateway-less network both compose projects share.
docker network create --internal hearth-nsfw-net
# …and add `hearth-nsfw-net` to hearth-orchestrator's `networks:` in the main
# /docker/docker-compose.yml, then `docker compose up -d hearth-orchestrator`.

cd ops/nsfw
./fetch-model.sh                 # ~27 MB SavedModel into ./model/ (gitignored, idempotent)
docker compose up -d --build
# No host port — reach it over hearth-nsfw-net from the orchestrator:
docker exec hearth-orchestrator curl -fsS http://hearth-nsfw:8094/health
docker exec hearth-orchestrator curl -F image=@/tmp/some.jpg http://hearth-nsfw:8094/classify
```

(Sanity: a benign photo returns `neutral ≈ 0.9`; the connector's default
thresholds — `HEARTH_NSFW_HIGH=0.5` / `HEARTH_NSFW_LOW=0.2` — then read that as
**SFW → household**. An explicit frame pushes `porn`/`hentai` high → **owner-only**.)

Wire it: set `HEARTH_NSFW_URL=http://hearth-nsfw:8094` (the container name, resolved
over `hearth-nsfw-net`) in `/docker/hearth/hearth.env` and
`docker compose up -d hearth-orchestrator` (an env_file change needs recreate,
not restart). Unset ⇒ the connector reports `available:false` and the runner
fails NSFW-classification closed to owner-only.

## nsfw/ sidecar contents

`Dockerfile` + `app.py` are intentionally tiny (< 80 lines). The MobileNetV2
SavedModel dir is bind-mounted from `./model/` (fetched by `fetch-model.sh`,
gitignored) so a re-create doesn't re-download. CPU is plenty; do **not** give
it a GPU (the cards are full — see the `project-glacier-steamboat-gpu-fleet`
memory).
