const UPSTREAM_TIMEOUT_MS = 180_000;
const RETRYABLE_PROVIDER_STATUS = new Set([429, 401, 403, 500, 502, 503, 504]);
const MAX_PROVIDER_RETRIES = 1; // یک بار تلاش مجدد با کلید دیگر (در مجموع ۲ تلاش)

// تابع برای دریافت لیست کلیدها و انتخاب تصادفی
function getRandomApiKey(env) {
    const keysString = env.UPSTREAM_API_KEYS || "";
    const keys = keysString.split(",").map(k => k.trim()).filter(k => k.length > 0);
    if (keys.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * keys.length);
    return keys[randomIndex];
}

export default {
  async fetch(request, env) {
    const base = String(env.UPSTREAM_BASE_URL || "").replace(/\/$/, "");
    const environment = env.ENVIRONMENT || "production"; // production, development

    if (!base) {
      return errorResponse("provider_not_configured", 500);
    }

    const incoming = new URL(request.url);
    const upstreamUrl = `${base}${incoming.pathname}${incoming.search}`;
    const method = request.method;
    const body = request.body;

    let lastErrorResponse = null;
    let usedApiKey = null;

    // تلاش با حداکثر ۲ کلید مختلف
    for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
      const apiKey = getRandomApiKey(env);
      if (!apiKey) {
        return errorResponse("provider_no_api_keys", 500);
      }

      usedApiKey = apiKey; // برای دیباگ

      const headers = new Headers(request.headers);

      // حذف هدرهای احراز هویت ارسالی از کلاینت
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.delete("x-auth-token");
      headers.delete("host");
      headers.delete("content-length");
      headers.delete("x-omniroute-provider");
      headers.delete("cf-connecting-ip");
      headers.delete("x-forwarded-for");
      headers.delete("x-real-ip");

      // تنظیم کلید انتخابی در هدر مناسب
      if ((env.AUTH_MODE || "bearer") === "x-api-key") {
        headers.set("x-api-key", apiKey);
      } else {
        headers.set("authorization", `Bearer ${apiKey}`);
      }

      // هدر رهگیری
      headers.set("x-provider-attempt", String(attempt));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

      try {
        const response = await fetch(new Request(upstreamUrl, {
          method,
          headers,
          body: attempt === 0 ? body : (body ? await request.arrayBuffer() : undefined), // برای retry بدنه را دوباره می‌خوانیم
          redirect: "follow",
        }), { signal: controller.signal });
        clearTimeout(timer);

        // اگر پاسخ موفق باشد یا خطای غیرقابل retry باشد، بلافاصله برگردان
        if (!RETRYABLE_PROVIDER_STATUS.has(response.status) || attempt === MAX_PROVIDER_RETRIES) {
          return buildResponse(response, apiKey, environment);
        }

        // در غیر این صورت، خطا را ذخیره کرده و برای تلاش بعدی ادامه می‌دهیم
        lastErrorResponse = response;
        // کمی صبر قبل از تلاش مجدد (اختیاری)
        await sleep(200 + Math.random() * 300);
        continue;
      } catch (error) {
        clearTimeout(timer);
        // اگر خطای شبکه بود و آخرین تلاش نبود، ادامه می‌دهیم
        if (attempt === MAX_PROVIDER_RETRIES) {
          return errorResponse(
            error?.name === "AbortError" ? "upstream_timeout" : "upstream_network_error",
            502
          );
        }
        await sleep(300 + Math.random() * 300);
        continue;
      }
    }

    // اگر همه تلاش‌ها ناموفق بود، آخرین پاسخ خطا را برمی‌گردانیم (اگر وجود داشته باشد)
    if (lastErrorResponse) {
      return buildResponse(lastErrorResponse, usedApiKey, environment);
    }

    return errorResponse("provider_failed", 502);
  },
};

function buildResponse(response, apiKey, environment) {
  const out = new Headers(response.headers);
  out.set("cache-control", "no-store");

  // فقط در محیط توسعه بخشی از کلید را نمایش بده
  if (environment !== "production") {
    out.set("x-used-api-key", apiKey ? apiKey.substring(0, 10) + "..." : "");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}

function errorResponse(code, status) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}