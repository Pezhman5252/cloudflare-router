// ─────────────────────────────────────────────────────────────────────────────
// OmniRoute Provider Worker (dahl)
//
// بین Router و upstream واقعی می‌نشیند:
//   - کلیدهای upstream از سکریت UPSTREAM_API_KEYS (با کاما جدا) خوانده می‌شوند
//   - در هر تلاش، کلید فعال با کمترین مصرف توکن انتخاب و تزریق می‌شود
//   - کلیدهایی که ۴۰۱/۴۰۳ بگیرند برای ۵ دقیقه در KV مسدود می‌شوند
//   - 429 (با احترام به Retry-After) و خطاهای موقتی شبکه retry می‌شوند
//   - مصرف توکن هر کلید در KV ثبت می‌شود
//
// نکته‌ی حیاتی: بدنه‌ی درخواست یک‌بار و قبل از حلقه‌ی retry بافر می‌شود.
// استریم body فقط یک‌بار قابل خواندن است و new Request آن را مصرف می‌کند؛
// بدون این بافر، هر retry یا چرخش کلید روی POST با «Body has already
// been consumed» شکست می‌خورد.
// ─────────────────────────────────────────────────────────────────────────────

const UPSTREAM_TIMEOUT_MS = 180_000;
// فقط 5xxها؛ 429 و 401/403 بالاتر با منطق اختصاصی خودشان مدیریت می‌شوند
const RETRYABLE_PROVIDER_STATUS = new Set([500, 502, 503, 504]);
const MAX_PROVIDER_RETRIES = 2;
const RATE_LIMIT_RETRIES = 3;
const BLOCK_DURATION_MS = 5 * 60 * 1000; // ۵ دقیقه

/**
 * دریافت لیست کلیدها و انتخاب کلید فعال با کمترین مصرف توکن
 * کلیدهای مسدودشده (401/403 اخیر) و کلیدهای حذف‌شده‌ی همین درخواست نادیده گرفته می‌شوند
 */
async function getLeastUsedApiKey(env, kv, excludeKeys) {
    const keysString = env.UPSTREAM_API_KEYS || "";
    const keys = keysString.split(",").map(k => k.trim()).filter(k => k.length > 0);
    if (keys.length === 0) return null;

    const excluded = new Set(excludeKeys);
    const keyStatuses = await Promise.all(keys.map(async (key) => {
        let isBlocked = false;
        let tokens = 0;
        try {
            const blocked = await kv.get(`blocked:${key}`, "text");
            isBlocked = Boolean(blocked) && parseInt(blocked, 10) > Date.now();
            const val = await kv.get(`tokens:${key}`, "text");
            tokens = val ? (parseInt(val, 10) || 0) : 0;
        } catch (_) {
            // خطای موقت KV: کلید را سالم و کم‌مصرف فرض می‌کنیم
        }
        return { key, tokens, isBlocked };
    }));

    const candidates = keyStatuses.filter(
        (item) => !item.isBlocked && !excluded.has(item.key)
    );

    if (candidates.length === 0) {
        // همه کلیدهای موجود مسدود هستند؛ اگر کلیدی هنوز در همین درخواست
        // امتحان نشده، همان را امتحان کن — فلگ مسدودی ممکن است کهنه باشد
        const untried = keyStatuses.find((item) => !excluded.has(item.key));
        if (untried) return untried.key;
        return null; // همه کلیدهای پیکربندی‌شده در همین درخواست امتحان شده‌اند
    }

    const selected = candidates.reduce((min, curr) => curr.tokens < min.tokens ? curr : min);
    return selected.key;
}

/**
 * مسدود کردن کلید برای مدت مشخص (در صورت دریافت ۴۰۱/۴۰۳)
 * نوشتن در KV «بهترین تلاش» است و هرگز پاسخ موفق را خراب نمی‌کند
 */
async function blockApiKey(kv, apiKey, ctx) {
    const expiry = String(Date.now() + BLOCK_DURATION_MS);
    const promise = kv.put(`blocked:${apiKey}`, expiry).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(promise);
    }
}

/**
 * افزایش مصرف توکن برای کلید مورد استفاده
 * در پس‌زمینه اجرا می‌شود (ctx.waitUntil) تا پاسخ را نگه ندارد
 */
async function incrementTokenUsage(kv, apiKey, tokenCount, ctx) {
    if (!tokenCount || tokenCount <= 0) return;
    const key = `tokens:${apiKey}`;
    const promise = (async () => {
        try {
            const current = await kv.get(key, "text");
            const newTotal = (current ? (parseInt(current, 10) || 0) : 0) + tokenCount;
            await kv.put(key, String(newTotal));
        } catch (_) {
            // آمار مصرف جنبه‌ی اطلاعاتی دارد؛ هرگز روی آن درخواست را نسوزان
        }
    })();
    if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(promise);
    }
}

/**
 * استخراج تعداد توکن مصرفی از پاسخ upstream
 * اولویت: هدر x-token-usage، سپس ساختارهای شناخته‌شده‌ی JSON
 * (پاسخ‌های streaming بدون این هدر، صفر برمی‌گردانند — بدنه برای آمار بافر نمی‌شود)
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
            const data = await response.clone().json();

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
 * محاسبه زمان انتظار برای ۴۲۹ بر اساس Retry-After (ثانیه یا HTTP-date) یا backoff
 */
function getRateLimitWaitTime(response, retryCount) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.min(seconds * 1000, 30000);
        }
        const date = Date.parse(retryAfter);
        if (!isNaN(date)) {
            return Math.min(Math.max(0, date - Date.now()), 30000);
        }
    }
    // backoff نمایی با jitter
    return Math.min(1000 * (2 ** (retryCount - 1)) + Math.random() * 500, 30000);
}

export default {
    async fetch(request, env, ctx) {
        const base = String(env.UPSTREAM_BASE_URL || "").replace(/\/+$/, "");
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

        // ── بدنه یک‌بار و قبل از حلقه بافر می‌شود ──
        const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
        const bodyBuffer = hasBody ? await request.arrayBuffer() : null;

        // کلیدهایی که در همین درخواست ۴۰۱/۴۰۳ گرفته‌اند؛ فقط این‌ها در
        // چرخش کلید حذف می‌شوند (چون KV تأخیر انتشار تا ~۶۰ ثانیه دارد و
        // نمی‌توان فقط به خواندن مجدد KV تکیه کرد). برای 5xx/خطای شبکه/429
        // کلید مقصر نیست و استفاده‌ی مجدد از همان کلید مجاز است.
        const failedKeys = [];
        let lastErrorResponse = null;
        let usedApiKey = null;
        let rateLimitRetries = 0;

        for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
            const apiKey = await getLeastUsedApiKey(env, kv, failedKeys);
            if (!apiKey) {
                // همه کلیدها در همین درخواست امتحان شده‌اند
                if (lastErrorResponse) {
                    return buildResponse(lastErrorResponse, usedApiKey, environment, 0);
                }
                return errorResponse("provider_all_keys_blocked", 503);
            }
            usedApiKey = apiKey;

            const headers = new Headers(request.headers);
            headers.delete("authorization");
            headers.delete("x-api-key");
            headers.delete("x-auth-token");
            headers.delete("x-router-api-key");
            headers.delete("host");
            headers.delete("content-length");
            headers.delete("x-omniroute-provider");
            headers.delete("x-retry-count");
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

            let response;
            try {
                response = await fetch(new Request(upstreamUrl, {
                    method,
                    headers,
                    body: bodyBuffer ? bodyBuffer.slice(0) : undefined,
                    redirect: "follow",
                }), { signal: controller.signal });
            } catch (error) {
                clearTimeout(timer);
                // در سطح شبکه، هر خطایی در تلاش‌های غیرآخر ارزش retry دارد
                // (در Workers خطاهای شبکه معمولاً «fetch failed» می‌آیند و
                // قابل تشخیص قطعی transient/غیر-transient نیستند)
                if (attempt < MAX_PROVIDER_RETRIES) {
                    await sleep(500 + Math.random() * 500);
                    continue;
                }
                return errorResponse(
                    error?.name === "AbortError" ? "upstream_timeout" : "upstream_network_error",
                    502
                );
            }
            clearTimeout(timer);

            // موفقیت
            if (response.status >= 200 && response.status < 300) {
                const tokenCount = await extractTokenUsage(response);
                incrementTokenUsage(kv, apiKey, tokenCount, ctx);
                return buildResponse(response, apiKey, environment, tokenCount);
            }

            // مدیریت ۴۲۹ با بودجه‌ی retry مجزا و شفاف (همان کلید)
            if (response.status === 429) {
                if (rateLimitRetries < RATE_LIMIT_RETRIES) {
                    rateLimitRetries++;
                    const waitTime = getRateLimitWaitTime(response, rateLimitRetries);
                    await sleep(waitTime);
                    attempt--; // بودجه‌ی retry معمولی را مصرف نکن
                    continue;
                }
                return buildResponse(response, apiKey, environment, 0);
            }

            // مسدودسازی کلید در صورت ۴۰۱/۴۰۳ و چرخش به کلید بعدی
            if (response.status === 401 || response.status === 403) {
                blockApiKey(kv, apiKey, ctx);
                failedKeys.push(apiKey);
                if (attempt < MAX_PROVIDER_RETRIES) {
                    lastErrorResponse = response;
                    continue; // تلاش بعدی حتماً کلید دیگری انتخاب می‌کند
                }
                return buildResponse(response, apiKey, environment, 0);
            }

            // خطای قابل retry دیگر (5xx)
            if (RETRYABLE_PROVIDER_STATUS.has(response.status) && attempt < MAX_PROVIDER_RETRIES) {
                lastErrorResponse = response;
                await sleep(200 + Math.random() * 300);
                continue;
            }

            // خطای غیرقابل retry یا آخرین تلاش: پاسخ واقعی upstream برگردد
            return buildResponse(response, apiKey, environment, 0);
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
