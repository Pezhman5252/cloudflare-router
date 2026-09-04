/**
 * OmniRoute Cloudflare Router (Improved)
 *
 * Base URLs for OmniRoute:
 *   https://<router-host>/a -> https://api.b.ai/v1
 *   https://<router-host>/b -> https://inference.dahl.global/v1
 *
 * OmniRoute appends endpoint paths itself.
 */

const ROUTES = [
  { prefix: "/a", binding: "BAI_WORKER", provider: "bai" },
  { prefix: "/b", binding: "DAHL_WORKER", provider: "dahl" },
];

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const ROUTER_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 300;
const RETRYABLE_STATUS = new Set([429, 401, 403, 500, 502, 503, 504]);

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (incoming.pathname === "/health") {
      return json({ ok: true, service: "omniroute-master-proxy" }, 200);
    }

    const route = resolveRoute(incoming.pathname);
    if (!route) {
      return json({ error: "unknown_provider" }, 404);
    }

    const gatewayKey = env.ROUTER_API_KEY;
    if (!gatewayKey) {
      return json({ error: "router_not_configured" }, 500);
    }

    const supplied = extractGatewayKey(request);
    if (!supplied || !timingSafeEqual(supplied, gatewayKey)) {
      return json({ error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    }

    const binding = env[route.binding];
    if (!binding || typeof binding.fetch !== "function") {
      return json({ error: "provider_binding_unavailable" }, 503);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json({ error: "request_body_too_large" }, 413);
    }

    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const downstreamPath = stripPrefix(incoming.pathname, route.prefix) + incoming.search;

    const bodyBuffer = request.body ? await request.arrayBuffer() : undefined;
    if (bodyBuffer && bodyBuffer.byteLength > MAX_BODY_BYTES) {
      return json({ error: "request_body_too_large" }, 413);
    }

    let lastResponse = null;
    let attempt = 0;

    for (attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const started = Date.now();
      const headers = new Headers(request.headers);

      headers.set("x-request-id", requestId);
      headers.set("x-omniroute-provider", route.provider);
      headers.set("x-retry-count", String(attempt));
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.delete("x-auth-token");
      headers.delete("host");
      headers.delete("content-length");
      headers.delete("cf-connecting-ip");
      headers.delete("x-forwarded-for");
      headers.delete("x-real-ip");
      headers.delete("x-router-api-key");

      const targetRequest = new Request(`https://internal${downstreamPath}`, {
        method: request.method,
        headers,
        body: bodyBuffer ? bodyBuffer.slice(0) : undefined,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS);

      try {
        const response = await binding.fetch(targetRequest, { signal: controller.signal });
        clearTimeout(timer);
        lastResponse = response;

        if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_RETRIES) {
          return decorate(response, requestId, route.provider, Date.now() - started, attempt);
        }

        await sleep(retryDelay(response, attempt));
      } catch (error) {
        clearTimeout(timer);
        if (attempt === MAX_RETRIES) break;
        await sleep(BASE_RETRY_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * 150));
      }
    }

    if (lastResponse) {
      return decorate(lastResponse, requestId, route.provider, 0, attempt);
    }

    return json({
      error: "upstream_unavailable",
      request_id: requestId,
      provider: route.provider,
    }, 502, { "x-request-id": requestId });
  },
};

function extractGatewayKey(request) {
  const custom = request.headers.get("x-router-api-key");
  if (custom) return custom.trim();

  const auth = request.headers.get("authorization") || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return "";
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function resolveRoute(pathname) {
  return ROUTES
    .slice()
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
}

function stripPrefix(pathname, prefix) {
  const result = pathname.slice(prefix.length);
  return result || "/";
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 10_000);
  }
  return BASE_RETRY_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * 150);
}

function decorate(response, requestId, provider, latencyMs, retryCount) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-omniroute-provider", provider);
  headers.set("x-proxy-latency-ms", String(latencyMs));
  headers.set("x-retry-count", String(retryCount));
  headers.set("cache-control", "no-store");

  const cors = corsHeaders();
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, Accept, X-Request-ID, X-Router-API-Key",
    "access-control-max-age": "86400",
  };
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}