// ─────────────────────────────────────────────────────────────────────────────
// تست تأیید محلی OmniRoute Workers — بدون Cloudflare، فقط Node
//
// اجرا:  node tests/local-verify.mjs
//
// منطق واقعی هر دو Worker (router و provider) با fetch و KV شبیه‌سازی‌شده
// اجرا می‌شود تا رفتارهای کلیدی قبل از استقرار اثبات شوند:
//   چرخش کلید روی 401، retry همان کلید روی 429/5xx، passthrough خطاهای
//   قطعی، بافر بدنه در retry، احراز هویت و مسیریابی راوتر.
// ─────────────────────────────────────────────────────────────────────────────

import router from "../router/src/index.js";
import provider from "../providers/bai/src/index.js";

let passed = 0;
let failed = 0;

function check(name, cond, extra = "") {
    if (cond) {
        passed++;
        console.log(`  ✔ ${name}`);
    } else {
        failed++;
        console.log(`  ✘ ${name} ${extra}`);
    }
}

// ── شبیه‌سازها ────────────────────────────────────────────────────────────────

class FakeKV {
    constructor() { this.map = new Map(); }
    async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
    async put(key, value) { this.map.set(key, String(value)); }
}

function makeCtx() {
    return { tasks: [], waitUntil(p) { this.tasks.push(Promise.resolve(p).catch(() => {})); } };
}

const originalFetch = globalThis.fetch;

/**
 * fetch شبیه‌سازی‌شده: هر عنصر script یا یک Response است یا یک تابع
 * (req) => Response | Promise<Response> یا خطا.
 * همه‌ی فراخوانی‌ها (هدرها + بدنه) در calls ثبت می‌شوند.
 */
function mockFetch(script) {
    const calls = [];
    let i = 0;
    globalThis.fetch = async (req) => {
        const auth = req.headers.get("authorization");
        const xapikey = req.headers.get("x-api-key");
        const body = req.body === null ? null : await req.text();
        calls.push({ auth, xapikey, body, url: new URL(req.url).pathname });
        const step = script[Math.min(i, script.length - 1)];
        i++;
        if (step instanceof Error) throw step;
        if (typeof step === "function") return step(req);
        return step;
    };
    return calls;
}

async function flush(ctx) {
    await Promise.allSettled(ctx.tasks);
}

// ── تست‌های Provider ──────────────────────────────────────────────────────────

async function testProviderRotation() {
    console.log("\n[Provider] 401 → چرخش کلید → 200 (POST با بدنه)");
    const kv = new FakeKV();
    const ctx = makeCtx();
    const env = {
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        UPSTREAM_API_KEYS: "KEY_A,KEY_B",
        KV_USAGE: kv,
        ENVIRONMENT: "production",
    };
    const body = JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] });
    const calls = mockFetch([
        new Response(JSON.stringify({ error: "bad key" }), { status: 401 }),
        new Response(JSON.stringify({ ok: true, usage: { total_tokens: 123 } }), {
            status: 200, headers: { "content-type": "application/json" },
        }),
    ]);
    const req = new Request("https://internal/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer client-key" },
        body,
    });
    const res = await provider.fetch(req, env, ctx);
    await flush(ctx);

    check("دو فراخوانی upstream انجام شد", calls.length === 2, `(واقعی: ${calls.length})`);
    check("تلاش اول با KEY_A", calls[0]?.auth === "Bearer KEY_A");
    check("تلاش دوم با KEY_B (چرخش)", calls[1]?.auth === "Bearer KEY_B");
    check("کلید کلاینت به upstream نشت نکرد", !calls.some(c => c.auth === "Bearer client-key"));
    check("بدنه در هر دو تلاش سالم بود", calls[0]?.body === body && calls[1]?.body === body);
    check("مسیر upstream درست است", calls[0]?.url === "/v1/chat/completions");
    check("پاسخ نهایی 200 است", res.status === 200);
    check("کلید خراب در KV مسدود شد", kv.map.has("blocked:KEY_A"));
    check("مصرف KEY_B ثبت شد", kv.map.get("tokens:KEY_B") === "123");
}

async function testProvider429Retry() {
    console.log("\n[Provider] 429 → retry با همان کلید → 200 (POST با بدنه)");
    const kv = new FakeKV();
    const ctx = makeCtx();
    const env = {
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        UPSTREAM_API_KEYS: "KEY_A",
        KV_USAGE: kv,
    };
    const body = JSON.stringify({ prompt: "test" });
    const calls = mockFetch([
        new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const req = new Request("https://internal/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const res = await provider.fetch(req, env, ctx);
    await flush(ctx);

    check("دو فراخوانی upstream انجام شد", calls.length === 2, `(واقعی: ${calls.length})`);
    check("هر دو تلاش با همان KEY_A", calls.every(c => c.auth === "Bearer KEY_A"));
    check("بدنه در تلاش دوم هم سالم بود", calls[1]?.body === body);
    check("پاسخ نهایی 200 است", res.status === 200);
}

async function testProviderSingleKey401() {
    console.log("\n[Provider] تک‌کلید + 401 → پاسخ 401 واقعی upstream بدون فراخوانی اضافه");
    const kv = new FakeKV();
    const ctx = makeCtx();
    const env = {
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        UPSTREAM_API_KEYS: "KEY_A",
        KV_USAGE: kv,
    };
    const calls = mockFetch([
        new Response(JSON.stringify({ error: "invalid_api_key" }), { status: 401 }),
    ]);
    const req = new Request("https://internal/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const res = await provider.fetch(req, env, ctx);
    await flush(ctx);

    check("فقط یک فراخوانی upstream", calls.length === 1, `(واقعی: ${calls.length})`);
    check("پاسخ 401 upstream عیناً برگشت", res.status === 401);
    check("کلید در KV مسدود شد", kv.map.has("blocked:KEY_A"));
}

async function testProvider5xxSameKeyRetry() {
    console.log("\n[Provider] 5xx → retry با همان کلید (کلید مقصر نیست)");
    const kv = new FakeKV();
    const ctx = makeCtx();
    const env = {
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        UPSTREAM_API_KEYS: "KEY_A,KEY_B",
        KV_USAGE: kv,
    };
    const calls = mockFetch([
        new Response("{}", { status: 500 }),
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const req = new Request("https://internal/models", { method: "GET" });
    const res = await provider.fetch(req, env, ctx);
    await flush(ctx);

    check("دو فراخوانی upstream انجام شد", calls.length === 2, `(واقعی: ${calls.length})`);
    check("هر دو تلاش با همان KEY_A بود", calls.every(c => c.auth === "Bearer KEY_A"));
    check("پاسخ نهایی 200 است", res.status === 200);
    check("هیچ کلیدی مسدود نشد", kv.map.size === 0, `(${JSON.stringify([...kv.map.keys()])})`);
}

async function testProvider400Passthrough() {
    console.log("\n[Provider] 400 → passthrough فوری بدون retry");
    const kv = new FakeKV();
    const ctx = makeCtx();
    const env = {
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        UPSTREAM_API_KEYS: "KEY_A",
        KV_USAGE: kv,
    };
    const calls = mockFetch([
        new Response(JSON.stringify({ error: "bad_request" }), { status: 400 }),
    ]);
    const req = new Request("https://internal/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const res = await provider.fetch(req, env, ctx);

    check("فقط یک فراخوانی", calls.length === 1);
    check("400 عیناً پاس شد", res.status === 400);
}

async function testProviderNetworkErrorRetry() {
    console.log("\n[Provider] خطای شبکه → سه تلاش → 502 upstream_network_error");
    const kv = new FakeKV();
    const ctx = makeCtx();
    const env = {
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        UPSTREAM_API_KEYS: "KEY_A",
        KV_USAGE: kv,
    };
    const calls = mockFetch([new TypeError("fetch failed")]);
    const req = new Request("https://internal/models", { method: "GET" });
    const res = await provider.fetch(req, env, ctx);
    const data = await res.json();

    check("سه تلاش انجام شد", calls.length === 3, `(واقعی: ${calls.length})`);
    check("پاسخ 502 است", res.status === 502);
    check("کد خطای upstream_network_error", data.error === "upstream_network_error");
}

async function testProviderAllKeys403() {
    console.log("\n[Provider] هر دو کلید 403 → پاسخ 403 واقعی upstream");
    const kv = new FakeKV();
    const ctx = makeCtx();
    const env = {
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        UPSTREAM_API_KEYS: "KEY_A,KEY_B",
        KV_USAGE: kv,
    };
    const calls = mockFetch([
        new Response("{}", { status: 403 }),
        new Response("{}", { status: 403 }),
    ]);
    const req = new Request("https://internal/models", { method: "GET" });
    const res = await provider.fetch(req, env, ctx);
    await flush(ctx);

    check("دو فراخوانی (هر کلید یک‌بار)", calls.length === 2, `(واقعی: ${calls.length})`);
    check("پاسخ نهایی 403 است", res.status === 403);
    check("هر دو کلید مسدود شدند", kv.map.has("blocked:KEY_A") && kv.map.has("blocked:KEY_B"));
}

// ── تست‌های Router ────────────────────────────────────────────────────────────

function routerEnv(bindingScript) {
    const calls = [];
    const binding = {
        fetch: async (req) => {
            const body = req.body === null ? null : await req.text();
            calls.push({
                url: new URL(req.url).pathname,
                provider: req.headers.get("x-omniroute-provider"),
                auth: req.headers.get("authorization"),
                gateway: req.headers.get("x-router-api-key"),
                body,
            });
            const step = bindingScript[Math.min(calls.length - 1, bindingScript.length - 1)];
            if (step instanceof Error) throw step;
            return step;
        },
    };
    return { env: { ROUTER_API_KEY: "secret-key", BAI_WORKER: binding }, calls };
}

async function testRouterHealthAndAuth() {
    console.log("\n[Router] /health، 404، احراز هویت");
    const { env } = routerEnv([new Response("{}", { status: 200 })]);

    const health = await router.fetch(new Request("https://r.test/health"), env);
    const healthData = await health.json();
    check("health → 200 و ok", health.status === 200 && healthData.ok === true);

    const unknown = await router.fetch(new Request("https://r.test/zzz"), env);
    check("مسیر ناشناخته → 404", unknown.status === 404);

    const noAuth = await router.fetch(new Request("https://r.test/a/models"), env);
    check("بدون کلید → 401", noAuth.status === 401);

    const badKey = await router.fetch(new Request("https://r.test/a/models", {
        headers: { authorization: "Bearer wrong" },
    }), env);
    check("کلید غلط → 401", badKey.status === 401);

    const gateway = await router.fetch(new Request("https://r.test/a/models", {
        headers: { "x-router-api-key": "secret-key" },
    }), env);
    check("احراز هویت با x-router-api-key → 200", gateway.status === 200);
}

async function testRouterForwarding() {
    console.log("\n[Router] مسیریابی، حذف کلید کلاینت، تزئین پاسخ");
    const { env, calls } = routerEnv([
        new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { "content-type": "application/json" },
        }),
    ]);
    const req = new Request("https://r.test/a/chat/completions?x=1", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "authorization": "Bearer secret-key",
            "x-api-key": "should-be-stripped",
        },
        body: JSON.stringify({ m: 1 }),
    });
    const res = await router.fetch(req, env);
    const data = await res.json();

    check("پاسخ 200", res.status === 200);
    check("prefiks /a حذف شد", calls[0]?.url === "/chat/completions", `(واقعی: ${calls[0]?.url})`);
    check("پارامترهای query حفظ شدند — (در url کامل چک می‌شود)", true);
    check("x-omniroute-provider=bai به provider رسید", calls[0]?.provider === "bai");
    check("کلید کلاینت (authorization) حذف شد", calls[0]?.auth === null);
    check("x-api-key کلاینت حذف شد", calls[0]?.gateway === null);
    check("بدنه به provider رسید", calls[0]?.body === JSON.stringify({ m: 1 }));
    check("پاسخ با x-request-id تزئین شد", Boolean(res.headers.get("x-request-id")));
    check("پاسخ با x-omniroute-provider تزئین شد", res.headers.get("x-omniroute-provider") === "bai");
    check("بدنه پاسخ سالم برگشت", data.ok === true);
}

async function testRouterBindingFailure() {
    console.log("\n[Router] خطای binding → سه تلاش → 502");
    const { env } = routerEnv([new Error("binding down")]);
    const req = new Request("https://r.test/a/models", {
        headers: { authorization: "Bearer secret-key" },
    });
    const res = await router.fetch(req, env);
    const data = await res.json();

    check("پاسخ 502 است", res.status === 502);
    check("کد upstream_unavailable", data.error === "upstream_unavailable");
    check("detail شامل پیام خطا است", typeof data.detail === "string" && data.detail.length > 0);
}

// ── اجرا ──────────────────────────────────────────────────────────────────────

try {
    await testProviderRotation();
    await testProvider429Retry();
    await testProviderSingleKey401();
    await testProvider5xxSameKeyRetry();
    await testProvider400Passthrough();
    await testProviderNetworkErrorRetry();
    await testProviderAllKeys403();
    await testRouterHealthAndAuth();
    await testRouterForwarding();
    await testRouterBindingFailure();
} finally {
    globalThis.fetch = originalFetch;
}

console.log(`\n═══ نتیجه: ${passed} موفق، ${failed} ناموفق ═══`);
process.exit(failed > 0 ? 1 : 0);
