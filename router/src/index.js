// مرتب‌سازی یک‌باره خارج از fetch
const ROUTES = [
  { prefix: "/a", binding: "BAI_WORKER", provider: "bai" },
  { prefix: "/b", binding: "DAHL_WORKER", provider: "dahl" },
  { prefix: "/c", binding: "TOKENROUTER_WORKER", provider: "tokenrouter" },
].sort((a, b) => b.prefix.length - a.prefix.length);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "polyroute-master-proxy", version: "5.0.9" });
    }

    // Route matching
    const route = ROUTES.find(r => url.pathname === r.prefix || url.pathname.startsWith(r.prefix + "/"));
    if (!route) {
      return jsonResponse({ error: "unknown_provider" }, 404);
    }

    // Authentication
    const gatewayKey = env.ROUTER_API_KEY;
    if (!gatewayKey) {
      return jsonResponse({ error: "router_not_configured" }, 500);
    }
    const supplied = request.headers.get("x-router-api-key") ||
                     (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(String(supplied).trim(), String(gatewayKey).trim())) {
      return jsonResponse({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }

    const binding = env[route.binding];
    if (!binding || typeof binding.fetch !== "function") {
      return jsonResponse({ error: "provider_binding_unavailable" }, 503);
    }

    // Apply an early Content-Length rejection without buffering the request.
    // Chunked/streamed bodies are bounded by the provider, which is the
    // authoritative replay boundary for retries and failover.
    // Parse exactly like the provider does (runtimeConfig): a non-positive or
    // non-numeric MAX_BODY_BYTES falls back to the default instead of, say,
    // "0" silently rejecting every request with a body.
    const maxBodyRaw = Number(env.MAX_BODY_BYTES);
    const maxBody = Number.isFinite(maxBodyRaw) && maxBodyRaw > 0 ? maxBodyRaw : 10485760;
    const contentLengthHeader = request.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
    if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxBody) {
      return jsonResponse({ error: "request_body_too_large" }, 413);
    }

    // Request ID
    const reqId = validId(request.headers.get("x-request-id"))
      ? request.headers.get("x-request-id")
      : crypto.randomUUID();

    // ساخت درخواست داخلی
    const headers = new Headers(request.headers);
    // Credentials and client identity never reach the provider; hop-by-hop
    // headers are removed and framing headers (host/content-length) are left
    // for the runtime to recompute, so the Service Binding request cannot
    // smuggle identity or stall on an unmatched Expect.
    const removeHeaders = [
      "authorization", "x-api-key", "x-auth-token", "x-router-api-key",
      "host", "content-length", "cf-connecting-ip", "x-forwarded-for", "x-real-ip",
      // hop-by-hop
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailer", "transfer-encoding", "upgrade",
      // request-modification
      "expect"
    ];
    for (const h of removeHeaders) headers.delete(h);
    headers.set("x-request-id", reqId);
    headers.set("x-polyroute-provider", route.provider);

    const targetPath = url.pathname.slice(route.prefix.length) || "/";
    const targetUrl = `https://internal${targetPath}${url.search}`;

    // The provider is the authoritative body-limit/replay boundary. The router
    // only performs an early Content-Length rejection here, then forwards the
    // original stream untouched. This avoids buffering the body twice while
    // preserving provider-side bounded buffering for retries/failover.
    const targetReq = new Request(targetUrl, {
      method: request.method,
      headers,
      body: request.body ?? undefined,
    });

    // ارسال به Provider
    try {
      const resp = await binding.fetch(targetReq);
      return decorateResponse(resp, reqId, route.provider);
    } catch (error) {
      console.error(`Provider ${route.provider} error:`, error?.stack || error);
      return jsonResponse({
        error: "provider_unavailable",
        request_id: reqId,
        provider: route.provider
      }, 502, { "x-request-id": reqId });
    }
  }
};

// ---- Helpers ----

function validId(v) {
  return !!v && /^[A-Za-z0-9._:=+@-]{1,128}$/.test(v);
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (typeof crypto?.subtle?.timingSafeEqual === "function") {
    if (aBytes.byteLength !== bBytes.byteLength) {
      // timingSafeEqual requires equal-length inputs. Compare a buffer with
      // itself before rejecting the different-length input.
      crypto.subtle.timingSafeEqual(aBytes, aBytes);
      return false;
    }
    return crypto.subtle.timingSafeEqual(aBytes, bBytes);
  }

  // Node's WebCrypto did not expose timingSafeEqual in every supported test
  // runtime. Keep a constant-work fallback for local tests and non-Workers
  // tooling; Cloudflare Workers uses the native implementation above.
  const len = Math.max(aBytes.byteLength, bBytes.byteLength);
  let diff = aBytes.byteLength ^ bBytes.byteLength;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, Accept, X-Request-ID, X-Router-API-Key",
    "access-control-max-age": "86400",
  };
}

function decorateResponse(resp, reqId, provider) {
  const headers = new Headers(resp.headers);
  // Defense in depth: an upstream/provider must never set cookies on the
  // gateway's origin.
  headers.delete("set-cookie");
  headers.set("x-request-id", reqId);
  headers.set("x-polyroute-provider", provider);
  headers.set("cache-control", "no-store");
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
      ...extra,
    },
  });
}