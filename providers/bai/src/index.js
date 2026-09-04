const UPSTREAM_TIMEOUT_MS = 180_000;
const RETRYABLE_PROVIDER_STATUS = new Set([429, 401, 403, 500, 502, 503, 504]);
const MAX_PROVIDER_RETRIES = 2;
const RATE_LIMIT_RETRIES = 3;
const BLOCK_DURATION_MS = 5 * 60 * 1000; // ۵ دقیقه

/**
 * دریافت لیست کلیدها و انتخاب کلید با کمترین مصرف توکن
 * کلیدهای مسدودشده را نادیده می‌گیرد
 */
async function getLeastUsedApiKey(env, kv) {
    const keysString = env.UPSTREAM_API_KEYS || "";
    const keys = keysString.split(",").map(k => k.trim()).filter(k => k.length > 0);
    if (keys.length === 0) return null;

    const keyStatuses = await Promise.all(keys.map(async (key) => {
        const blocked = await kv.get(`blocked:${key}`, "text");
        const isBlocked = blocked && parseInt(blocked, 10) > Date.now();
        const val = await kv.get(`tokens:${key}`, "text");
        const tokens = val ? parseInt(val, 10) : 0;
        return { key, tokens, isBlocked };
    }));

    const availableKeys = keyStatuses.filter(item => !item.isBlocked);
    if (availableKeys.length === 0) {
        return keys[0];
    }

    const selected = availableKeys.reduce((min, curr) => curr.tokens < min.tokens ? curr : min);
    return selected.key;
}

/**
 * مسدود کردن کلید برای مدت مشخص (در صورت دریافت ۴۰۱/۴۰۳)
 */
async function blockApiKey(kv, apiKey) {
    const expiry = Date.now() + BLOCK_DURATION_MS;
    await kv.put(`blocked:${apiKey}`, String(expiry));
}

/**
 * افزایش مصرف توکن برای کلید مورد استفاده
 */
async function incrementTokenUsage(kv, apiKey, tokenCount) {
    if (!tokenCount || tokenCount <= 0) return;
    const key = `tokens:${apiKey}`;
    const current = await kv.get(key, "text");
    const newTotal = (current ? parseInt(current, 10) : 0) + tokenCount;
    await kv.put(key, String(newTotal));
}

/**
 * استخراج تعداد توکن مصرفی از پاسخ upstream
 */
async function extractTokenUsage(response) {
    const headerToken = response.headers.get("x-token-usage");
    if (headerToken) {
        const num = parseInt(headerToken, 10);
        if (!isNaN(num) && num > 0) return num;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
        try {
            const clonedResponse = response.clone();
            const data = await clonedResponse.json();
            
            if (data?.usage?.total_tokens) return data.usage.total_tokens;
            if (data?.usage?.total_token_count) return data.usage.total_token_count;
            if (data?.usage?.prompt_tokens && data?.usage?.completion_tokens) {
                return data.usage.prompt_tokens + data.usage.completion_tokens;
            }
            if (data?.total_tokens) return data.total_tokens;
            if (data?.token_usage?.total_tokens) return data.token_usage.total_tokens;
        } catch (_) {}
    }

    return 0;
}

/**
 * محاسبه زمان انتظار برای ۴۲۹ بر اساس Retry-After یا backoff
 */
function getRateLimitWaitTime(response, retryCount) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds) && seconds > 0) {
            return Math.min(seconds * 1000, 30000);
        }
    }
    // backoff نمایی با jitter
    return Math.min(1000 * (2 ** (retryCount - 1)) + Math.random() * 500, 30000);
}

/**
 * بررسی اینکه آیا خطا موقتی است یا دائمی
 */
function isTransientNetworkError(error) {
    const message = error?.message || "";
    const transientErrors = [
        "ECONNRESET",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ENOTFOUND"
    ];
    return transientErrors.some(err => message.includes(err));
}

export default {
    async fetch(request, env) {
        const base = String(env.UPSTREAM_BASE_URL || "").replace(/\/$/, "");
        const environment = env.ENVIRONMENT || "production";
        const kv = env.KV_USAGE;

        if (!base) {
            return errorResponse("provider_not_configured", 500);
        }
        if (!kv) {
            return errorResponse("kv_not_configured", 500);
        }

        const incoming = new URL(request.url);
        const upstreamUrl = `${base}${incoming.pathname}${incoming.search}`;
        const method = request.method;
        const body = request.body;

        let lastErrorResponse = null;
        let usedApiKey = null;
        let tokenCount = 0;
        let rateLimitRetries = 0;

        for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
            const apiKey = await getLeastUsedApiKey(env, kv);
            if (!apiKey) {
                return errorResponse("provider_no_api_keys", 500);
            }
            usedApiKey = apiKey;

            const headers = new Headers(request.headers);
            headers.delete("authorization");
            headers.delete("x-api-key");
            headers.delete("x-auth-token");
            headers.delete("host");
            headers.delete("content-length");
            headers.delete("x-omniroute-provider");
            headers.delete("cf-connecting-ip");
            headers.delete("x-forwarded-for");
            headers.delete("x-real-ip");

            if ((env.AUTH_MODE || "bearer") === "x-api-key") {
                headers.set("x-api-key", apiKey);
            } else {
                headers.set("authorization", `Bearer ${apiKey}`);
            }
            headers.set("x-provider-attempt", String(attempt));

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

            try {
                const response = await fetch(new Request(upstreamUrl, {
                    method,
                    headers,
                    body: attempt === 0 ? body : (body ? await request.arrayBuffer() : undefined),
                    redirect: "follow",
                }), { signal: controller.signal });
                clearTimeout(timer);

                // موفقیت
                if (response.status >= 200 && response.status < 300) {
                    tokenCount = await extractTokenUsage(response);
                    await incrementTokenUsage(kv, apiKey, tokenCount);
                    return buildResponse(response, apiKey, environment, tokenCount);
                }

                // مدیریت ۴۲۹ با حلقه‌ای مجزا و شفاف
                if (response.status === 429) {
                    if (rateLimitRetries < RATE_LIMIT_RETRIES) {
                        rateLimitRetries++;
                        const waitTime = getRateLimitWaitTime(response, rateLimitRetries);
                        await sleep(waitTime);
                        // با همان کلید دوباره تلاش می‌کنیم (بدون تغییر attempt)
                        attempt--;
                        continue;
                    } else {
                        // تعداد تلاش‌های ۴۲۹ تمام شد
                        return buildResponse(response, apiKey, environment, 0);
                    }
                }

                // مسدودسازی کلید در صورت ۴۰۱/۴۰۳
                if (response.status === 401 || response.status === 403) {
                    await blockApiKey(kv, apiKey);
                }

                // خطای قابل Retry (غیر از ۴۲۹)
                if (RETRYABLE_PROVIDER_STATUS.has(response.status) && attempt < MAX_PROVIDER_RETRIES) {
                    lastErrorResponse = response;
                    await sleep(200 + Math.random() * 300);
                    continue;
                }

                return buildResponse(response, apiKey, environment, 0);

            } catch (error) {
                clearTimeout(timer);
                if (isTransientNetworkError(error) && attempt < MAX_PROVIDER_RETRIES) {
                    await sleep(500 + Math.random() * 500);
                    continue;
                }
                if (attempt === MAX_PROVIDER_RETRIES) {
                    return errorResponse(
                        error?.name === "AbortError" ? "upstream_timeout" : "upstream_network_error",
                        502
                    );
                }
                await sleep(300 + Math.random() * 300);
            }
        }

        if (lastErrorResponse) {
            return buildResponse(lastErrorResponse, usedApiKey, environment, 0);
        }

        return errorResponse("provider_failed", 502);
    },
};

function buildResponse(response, apiKey, environment, tokenCount) {
    const out = new Headers(response.headers);
    out.set("cache-control", "no-store");
    if (environment !== "production") {
        out.set("x-used-api-key", apiKey ? apiKey.substring(0, 10) + "..." : "");
        out.set("x-token-usage", String(tokenCount));
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