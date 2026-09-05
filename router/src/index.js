// مرتب‌سازی یک‌باره خارج از fetch
const ROUTES = [
  { prefix: "/a", binding: "BAI_WORKER", provider: "bai" },
  { prefix: "/b", binding: "DAHL_WORKER", provider: "dahl" },
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
      return jsonResponse({ ok: true, service: "omniroute-master-proxy", version: "4.0.1" });
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
    if (!timingSafeEqual(String(supplied).trim(), gatewayKey)) {
      return jsonResponse({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }

    const binding = env[route.binding];
    if (!binding || typeof binding.fetch !== "function") {
      return jsonResponse({ error: "provider_binding_unavailable" }, 503);
    }

    // محدودیت حجم بدنه
    const maxBody = Number(env.MAX_BODY_BYTES || 26214400);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBody) {
      return jsonResponse({ error: "request_body_too_large" }, 413);
    }

    // Request ID
    const reqId = validId(request.headers.get("x-request-id"))
      ? request.headers.get("x-request-id")
      : crypto.randomUUID();

    // ساخت درخواست داخلی
    const headers = new Headers(request.headers);
    const removeHeaders = [
      "authorization", "x-api-key", "x-auth-token", "x-router-api-key",
      "host", "content-length", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"
    ];
    for (const h of removeHeaders) headers.delete(h);
    headers.set("x-request-id", reqId);
    headers.set("x-omniroute-provider", route.provider);

    const targetPath = url.pathname.slice(route.prefix.length) || "/";
    const targetUrl = `https://internal${targetPath}${url.search}`;
    const targetReq = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.body,
    });

    // ارسال به Provider
    try {
      const resp = await binding.fetch(targetReq);
      return decorateResponse(resp, reqId, route.provider);
    } catch (error) {
      console.error(`Provider ${route.provider} error:`, error.message);
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
  // حلقه همیشه به طول رشته‌ی بلندتر اجرا می‌شود تا زمان‌بندی، طول کلید را لو ندهد
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
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
  headers.set("x-request-id", reqId);
  headers.set("x-omniroute-provider", provider);
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