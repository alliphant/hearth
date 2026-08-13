/**
 * Minimal ComfyUI client.
 *
 * The orchestrator submits a prebuilt workflow graph, polls the history
 * endpoint until ComfyUI reports the prompt is complete (or it times
 * out), and pulls the resulting image bytes from /view. Also exposes an
 * upload path so img2img workflows can reference a freshly-pushed input
 * image by filename.
 *
 * We deliberately do NOT wrap ComfyUI's WebSocket — polling is the
 * simplest thing that works, the workloads are 5–60 s each, and the
 * caller is one HTTP request the user is already waiting on.
 *
 * `base_url` is REQUIRED — there is deliberately no default. It used to
 * fall back to `HEARTH_COMFYUI_URL`, the CPU FLUX instance on the LLM host;
 * that install was retired 2026-07-30, and a default would let a new
 * caller silently address a dead host instead of failing where it is
 * written. The one live install is forza's GPU ComfyUI, addressed via
 * `HEARTH_IMAGEGEN_COMFYUI_URL` (see src/tools/generate_image.ts).
 */

export interface ComfyOutputImage {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyHistoryEntry {
  outputs: Record<string, { images?: ComfyOutputImage[] }>;
  status: { completed: boolean; status_str?: string; messages?: unknown[] };
}

export class ComfyUIClient {
  constructor(private base_url: string) {}

  async submit(workflow: Record<string, unknown>): Promise<string> {
    const client_id = `hearth-${crypto.randomUUID()}`;
    const res = await fetch(`${this.base_url}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`comfy submit failed: HTTP ${res.status} ${body.slice(0, 400)}`);
    }
    const j = (await res.json()) as { prompt_id?: string; error?: { message?: string } };
    if (!j.prompt_id) {
      throw new Error(`comfy submit: no prompt_id (${JSON.stringify(j).slice(0, 200)})`);
    }
    return j.prompt_id;
  }

  /** Poll history until the prompt is complete or `timeout_ms` elapses. */
  async wait(prompt_id: string, timeout_ms = 180_000): Promise<ComfyHistoryEntry> {
    const deadline = Date.now() + timeout_ms;
    let delay = 600;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      // Keep polls cheap as the job runs, then back off.
      delay = Math.min(delay + 200, 2_500);
      const res = await fetch(`${this.base_url}/history/${prompt_id}`);
      if (!res.ok) continue;
      const hist = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = hist[prompt_id];
      if (entry && entry.status && entry.status.completed) return entry;
    }
    throw new Error(`comfy wait: prompt ${prompt_id} did not complete in ${timeout_ms}ms`);
  }

  async fetch_image(img: ComfyOutputImage): Promise<Uint8Array> {
    const url =
      `${this.base_url}/view` +
      `?filename=${encodeURIComponent(img.filename)}` +
      `&subfolder=${encodeURIComponent(img.subfolder || '')}` +
      `&type=${encodeURIComponent(img.type || 'output')}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`comfy fetch_image: HTTP ${res.status} for ${img.filename}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Upload a file to ComfyUI's input folder; returns the stored filename. */
  async upload_input_image(bytes: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    // Slice into a Blob to satisfy lib.dom's stricter BlobPart typing
    // around SharedArrayBuffer-backed Uint8Arrays.
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer]);
    form.append('image', new File([blob], filename), filename);
    form.append('overwrite', 'true');
    const res = await fetch(`${this.base_url}/upload/image`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`comfy upload failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const j = (await res.json()) as { name?: string };
    if (!j.name) throw new Error(`comfy upload: no name returned`);
    return j.name;
  }

  /** Convenience: submit, wait, return the first output image's bytes. */
  async run_workflow(
    workflow: Record<string, unknown>,
    timeout_ms = 180_000,
  ): Promise<Uint8Array> {
    const prompt_id = await this.submit(workflow);
    const entry = await this.wait(prompt_id, timeout_ms);
    for (const node_id of Object.keys(entry.outputs)) {
      const imgs = entry.outputs[node_id]?.images;
      if (imgs && imgs.length > 0 && imgs[0]) return this.fetch_image(imgs[0]);
    }
    throw new Error(`comfy run_workflow: no output images for prompt ${prompt_id}`);
  }

  /** Liveness check — used by routes to fail-fast with a clean error. */
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base_url}/system_stats`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
