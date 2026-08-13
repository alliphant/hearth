import { getSessionByGd } from "./sessions";
import { debug, warn } from "./log";

// Reverse-proxy a WebDriver request to the per-session geckodriver.
// Matched path is everything after "/wd" (so "/wd/session/abc/url" => "/session/abc/url").
export async function proxyWebDriver(
  req: Request,
  url: URL,
  pathAfterWd: string,
): Promise<Response> {
  // Extract gd_session_id from /session/{id}/...
  const m = pathAfterWd.match(/^\/session\/([^/]+)/);
  if (!m) {
    return new Response(JSON.stringify({ error: "no_session_id_in_path" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const gdSessionId = m[1];
  const sess = getSessionByGd(gdSessionId);
  if (!sess) {
    return new Response(JSON.stringify({ error: "unknown_session" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const target = `http://127.0.0.1:${sess.port}${pathAfterWd}${url.search}`;
  debug("wd_proxy_request", {
    session_id: sess.session_id,
    method: req.method,
    target,
  });

  // Clone headers minus auth + host
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    const lk = k.toLowerCase();
    if (lk === "x-agentd-auth" || lk === "host" || lk === "content-length") continue;
    headers.set(k, v);
  }

  let bodyForFetch: BodyInit | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Buffer it — webdriver bodies are tiny.
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 0) {
      bodyForFetch = buf;
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: bodyForFetch,
      // No timeout — long-poll for elements etc.
    });
  } catch (e) {
    warn("wd_proxy_upstream_error", {
      session_id: sess.session_id,
      error: (e as Error).message,
    });
    return new Response(
      JSON.stringify({ error: "upstream_unreachable", message: (e as Error).message }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  sess.last_activity_at = Date.now();

  // Stream response back
  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    // Drop headers that Bun will re-compute
    if (lk === "content-encoding" || lk === "transfer-encoding" || lk === "content-length")
      continue;
    respHeaders.set(k, v);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}
