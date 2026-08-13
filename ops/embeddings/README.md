# RAG embeddings + rerank server (infinity on the A4000)

The vector half of the RAG pipeline (Pass 7 / RAG Phase 2, shipped
2026-06-04). Serves `BAAI/bge-large-en-v1.5` (1024-dim embeddings) and
`BAAI/bge-reranker-v2-m3` (cross-encoder rerank) from one
[infinity](https://github.com/michaelfeil/infinity) server on the LLM host's
**RTX A4000**, OpenAI-compatible.

Consumed by [src/core/embeddings.ts](../../src/core/embeddings.ts) →
`retrieve_hybrid`; gated by `HEARTH_RAG_VECTOR=1`. The orchestrator reaches it
at `http://host.docker.internal:8091`. See the "RAG retrieval" section of
[the private dev log](../../the private dev log) for the query path.

## Run / rebuild

Standalone container (NOT in `/docker/docker-compose.yml` yet —
`--restart unless-stopped` survives reboots). The HF model cache is
bind-mounted so a re-create doesn't re-download.

```bash
docker run -d --name hearth-embeddings --restart unless-stopped \
  --gpus '"device=0"' \
  -p 8091:7997 \
  -e HF_HOME=/cache \
  -v /docker/hearth-embeddings/cache:/cache \
  michaelf34/infinity:latest \
  v2 --model-id BAAI/bge-large-en-v1.5 --model-id BAAI/bge-reranker-v2-m3 \
  --port 7997 --device cuda
```

- **`--gpus '"device=0"'`** pins to the A4000 (nvidia index 0). Confirm with
  `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` — infinity is
  ~3.2 GB on GPU 0. **Do NOT let it land on the 3090 (index 1)** — that GPU is
  full with the 27B.
- CPU fallback (no A4000 free): drop `--gpus` and use `--device cpu`. Slower
  but adequate at vault scale; the LLM host's Xeon has AMX. (The original bring-up
  ran on CPU until the A4000 was freed.)
- Routes are at **ROOT** (no `/v1`): `POST /embeddings`, `POST /rerank`,
  `GET /models`, `GET /health`. The `embeddings`/`reranker` roles in
  `config/llm-roles.yaml` therefore use `base_url: http://host.docker.internal:8091`
  (no suffix) and the **full HF model ids**.

## Smoke

```bash
curl -s localhost:8091/health
curl -s localhost:8091/models | python3 -m json.tool          # → the two BAAI ids
curl -s localhost:8091/embeddings -H 'content-type: application/json' \
  -d '{"model":"BAAI/bge-large-en-v1.5","input":["knee rehab"]}' \
  | python3 -c 'import sys,json;print("dim",len(json.load(sys.stdin)["data"][0]["embedding"]))'   # → dim 1024
curl -s localhost:8091/rerank -H 'content-type: application/json' \
  -d '{"model":"BAAI/bge-reranker-v2-m3","query":"knee rehab","documents":["dell invoice","knee rehab squats"],"return_documents":false}'
```

## Backfill after a model swap

A model change (different dimensionality) means the stored vectors no longer
match. Re-embed the whole corpus:

```bash
docker compose exec hearth-orchestrator bun run backfill:embeddings -- --force
```

(Without `--force` the backfill is resumable and skips chunks already embedded
with the current model.)

## The A4000 freeing (one-time, 2026-06-04)

This box used to run the IQ2-27B LIVE tier (`llamacpp-live-glacier.service`,
`:8089`). RAG Phase 2 retired it and moved `live`/`librarian` to forza's 80B:

```bash
sudo systemctl stop --now llamacpp-live-glacier.service
sudo systemctl disable llamacpp-live-glacier.service
```

Rollback (Astrid back on the A4000): re-enable that service and revert the
`live`/`librarian` `base_url`/`model` in `config/llm-roles.yaml` (inline
rollback notes are there), then `docker compose restart hearth-orchestrator`.
