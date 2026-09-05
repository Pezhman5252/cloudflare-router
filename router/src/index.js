/**
 * OmniRoute Cloudflare Router
 *
 * Base URLs for OmniRoute:
 *   https://<router-host>/a -> https://api.b.ai/v1      (service: omniroute-provider-bai)
 *   https://<router-host>/b -> https://inference.dahl.global/v1 (service: omniroute-provider-dahl)
 *
 * OmniRoute appends endpoint paths itself (e.g. /a/chat/completions).
 *
 * طراحی لایه‌ها:
 *   - این Router فقط احراز هویت کلاینت، مسیریابی و هدرهای تزئینی را انجام می‌دهد.
 *   - retry، 429/Retry-After، چرخش و مسدودسازی کلید و تایم‌اوت upstream
 *     به‌طور کامل در Provider Workerها انجام می‌شود تا «تشدید retry»
 *     (۹ فراخوانی upstream برای یک درخواست) رخ ندهد.
 *   - فقط خطاهای خودِ binding (قابل‌دستیار نبودن Worker مقصد) تا ۳ تلاش
 *     با backoff نمایی تکرار می‌شود؛ پاسخ‌های status هیچ‌گاه بازتولید نمی‌شوند.
 */

const ROUTES = [
  { prefix: "/a", binding: "BAI_WORKER", provider: "bai" },
  { prefix: "/b", binding: "DAHL_WORKER", provider: "dahl" },
];

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const BINDING_RETRIES = 2;           // فقط برای خطای فراخوانی binding؛ کل تلاش‌ها: ۳
const BASE_RETRY_DELAY_MS = 300;

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

    // trim: اگر سکریت با newline انتهایی ذخیره شده باشد، مقایسه همیشه شکست می‌خورد
    const gatewayKey = String(env.ROUTER_API_KEY || "").trim();
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

    // بدنه یک‌بار بافر می‌شود تا در صورت نیاز به retry خطای binding،
    // استریم مصرف‌شده دوباره قابل استفاده باشد.
    const bodyBuffer = request.body ? await request.arrayBuffer() : null;
    if (bodyBuffer && bodyBuffer.byteLength > MAX_BODY_BYTES) {
      return json({ error: "request_body_too_large" }, 413);
    }

    let lastError = null;

    for (let attempt = 0; attempt <= BINDING_RETRIES; attempt++) {
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

      // سیگنال از طریق خود Request پاس داده می‌شود تا در صورت پشتیبانی
      // پیاده‌سازی binding از لغو درخواست، تایم‌اوت معنا داشته باشد.
      const targetRequest = new Request(`https://internal${downstreamPath}`, {
        method: request.method,
        headers,
        body: bodyBuffer ? bodyBuffer.slice(0) : undefined,
        signal: AbortSignal.timeout(180_000),
      });

      try {
        const response = await binding.fetch(targetRequest);
        // هر پاسخی (حتی 5xx/429) همان چیزی است که Provider تولید کرده؛
        // دوباره فراخوانی نکن — Provider خودش retry/چرخش کلید را انجام داده است.
        return decorate(response, requestId, route.provider);
      } catch (error) {
        lastError = error;
        if (attempt < BINDING_RETRIES) {
          await sleep(BASE_RETRY_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * 150));
        }
      }
    }

    return json({
      error: "upstream_unavailable",
      detail: lastError instanceof Error ? String(lastError.message) : "binding_fetch_failed",
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

function decorate(response, requestId, provider) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-omniroute-provider", provider);
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
