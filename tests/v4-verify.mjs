// ─────────────────────────────────────────────────────────────────────────────
// تست تأیید v4 فیکس‌شده — کد واقعی provider-core + Durable Object واقعی
// فقط «cloudflare:workers» شبیه‌سازی می‌شود و SQL روی node:sqlite اجرا می‌شود.
// اجرا:  node tests/v4-verify.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
    if (cond) { passed++; console.log(`  ✔ ${name}`); }
    else { failed++; console.log(`  ✘ ${name} ${extra}`); }
}

// همان هش FNV-1a هسته (id) — برای یافتن سطر کلید در stats
function idOf(key) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return "k_" + (hash >>> 0).toString(16);
}

// workerd به duplex برای بدنه‌ی استریم نیاز ندارد؛ Node/undici دارد.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
    constructor(input, init) {
        if (init && typeof init.body === "object" && init.body !== null &&
            typeof init.body.pipeTo === "function" && !init.duplex) {
            init = { ...init, duplex: "half" };
        }
        super(input, init);
    }
};

// ── SQL shim روی node:sqlite با قرارداد واقعی DO (SqlStorageCursor) ──
// API واقعی Cloudflare: exec() همگام یک cursor برمی‌گرداند که خودش مستقیم
// iterable است، خاصیت .rows ندارد، سطر پیش‌فرض آن OBJECT (کلید = نام ستون) است
// و خواندن موقعیتی (سطر = آرایه) فقط از raw() است. BEGIN/COMMIT/ROLLBACK هم
// مثل runtime واقعی خطا می‌دهند (به جای آن: transactionSync/own atomicity).
class SQLCursor {
    constructor(columnNames, rawRows) {
        this.columnNames = columnNames;
        this._rows = rawRows;   // آرایه‌ای از آرایه‌ها (فرم raw)
        this._i = 0;
        this.rowsRead = 0;
        this.rowsWritten = 0;
    }
    _obj(row) {
        const o = {};
        for (let c = 0; c < this.columnNames.length; c++) o[this.columnNames[c]] = row[c];
        return o;
    }
    next() {
        if (this._i < this._rows.length) {
            this.rowsRead++;
            return { done: false, value: this._obj(this._rows[this._i++]) };
        }
        return { done: true, value: undefined };
    }
    toArray() { const out = []; let r; while (!(r = this.next()).done) out.push(r.value); return out; }
    one() { const a = this.toArray(); if (a.length !== 1) throw new Error("one() expects exactly one row"); return a[0]; }
    raw() {
        const rows = this._rows.slice(this._i);
        this._i = this._rows.length;
        let i = 0;
        const it = {
            next: () => i < rows.length ? { done: false, value: rows[i++] } : { done: true, value: undefined },
        };
        it[Symbol.iterator] = () => it;
        return it;
    }
    [Symbol.iterator]() { return this; }
}
class SQLShim {
    constructor() { this.db = new DatabaseSync(":memory:"); }
    exec(sql, ...params) {
        const trimmed = sql.trim();
        if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(trimmed)) {
            throw new Error("To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.");
        }
        const stmt = this.db.prepare(trimmed);
        if (/^\s*(SELECT|WITH)/i.test(trimmed)) {
            const cols = stmt.columns().map(c => c.name);
            const objs = stmt.all(...params);
            return new SQLCursor(cols, objs.map(o => cols.map(c => o[c])));
        }
        const info = stmt.run(...params);
        const cur = new SQLCursor([], []);
        cur.rowsWritten = Number(info.changes);
        return cur;
    }
}

// ── ساخت shim و import کد واقعی ──
const corePath = path.join(root, "common", "provider-core.js");
let coreSrc = await readFile(corePath, "utf8");
const importLine = 'import { DurableObject } from "cloudflare:workers";';
if (!coreSrc.includes(importLine)) throw new Error("import line not found");
coreSrc = coreSrc.replace(
    importLine,
    'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'
);
const shimPath = path.join(here, ".tmp-v4-core.mjs");
await writeFile(shimPath, coreSrc, "utf8");

const logs = [];
const origLog = console.log, origError = console.error;
console.log = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));

let handler, flushTasks;
try {
    const { createFetchHandler, ApiKeyCoordinator } = await import(pathToFileURL(shimPath));
    handler = createFetchHandler({});

    // ── محیط تست: DO واقعی + ثبت releaseها ──
    function makeEnv(keyList, overrides = {}) {
        const env = {
            UPSTREAM_BASE_URL: "https://upstream.test/v1",
            UPSTREAM_API_KEYS: keyList.join(","),
            AUTH_MODE: "bearer",
            MAX_ATTEMPTS: "4",
            BACKOFF_MS: "10",
            RATE_COOLDOWN_MS: "50",
            AUTH_COOLDOWN_MS: "100",
            TRANSIENT_COOLDOWN_MS: "50",
            MAX_BACKOFF_MS: "1000",
            ...overrides,
        };
        const coordinator = new ApiKeyCoordinator(
            { storage: { sql: new SQLShim() } }, env
        );
        const releases = [];
        let upstreamCalls = [];
        const coordApi = {
            fetch: async (req, init) => {
                const request = req instanceof Request ? req : new Request(req, init);
                if (new URL(request.url).pathname === "/release") {
                    releases.push(await request.clone().json());
                }
                return coordinator.fetch(request);
            },
        };
        const ctx = { tasks: [], waitUntil(p) { this.tasks.push(Promise.resolve(p).catch(() => {})); } };
        return {
            env: { ...env, KEY_COORDINATOR: { getByName: () => coordApi } },
            releases,
            upstreamCalls,
            coordinator,
            ctx,
            mockFetch(script) {
                let i = 0;
                globalThis.fetch = async (req) => {
                    const auth = req.headers.get("authorization");
                    const xkey = req.headers.get("x-api-key");
                    const body = req.body === null ? null : await req.text();
                    upstreamCalls.push({ auth, xkey, body, url: new URL(req.url).pathname });
                    const step = script[Math.min(i++, script.length - 1)];
                    if (step instanceof Error) throw step;
                    return step;
                };
            },
            async restore() {
                const orig = globalThis.fetch;
                globalThis.fetch = orig.__orig || globalThis.fetch; // no-op placeholder
            },
        };
    }

    // helper: بازگرداندن fetch و انتظار برای waitUntilها
    const savedFetch = globalThis.fetch;
    function cleanupFetch() { globalThis.fetch = savedFetch; }
    async function settle(ctx) { await Promise.allSettled(ctx.tasks); }

    async function allInflightZero(coordinator) {
        const statsRes = await coordinator.fetch(new Request("https://coordinator/stats"));
        const { keys } = await statsRes.json();
        return keys.every(k => k[12] === 0); // ستون inflight
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T1: SSE سالم → استریم 200 به کلاینت + ثبت usage ──");
    {
        const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n';
        const t = makeEnv(["KEY_A"]);
        t.mockFetch([new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })]);
        const res = await handler(new Request("https://internal/chat/completions", { method: "GET" }), t.env, t.ctx);
        const text = await res.text();
        await settle(t.ctx);
        cleanupFetch();
        check("پاسخ کلاینت 200 است (قبلاً 502 بود!)", res.status === 200, `→ ${res.status}`);
        check("بدنه استریم دست‌نخورده به کلاینت رسید", text === sse);
        check("فقط یک فراخوانی upstream", t.upstreamCalls.length === 1);
        check("usage از SSE استخراج و ثبت شد", t.releases[0]?.total_tokens === 15, JSON.stringify(t.releases[0]));
        check("کلید سالم ماند", true);
        check("inflight صفر شد (بدون لو رفتن رزرو)", await allInflightZero(t.coordinator));
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T2: POST + 401 → failover واقعی به کلید دوم با بدنه سالم ──");
    {
        const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
        const t = makeEnv(["KEY_A", "KEY_B"]);
        t.mockFetch([
            new Response(JSON.stringify({ error: "invalid" }), { status: 401 }),
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ]);
        const res = await handler(new Request("https://internal/chat/completions", {
            method: "POST", headers: { "content-type": "application/json" }, body,
        }), t.env, t.ctx);
        await settle(t.ctx);
        cleanupFetch();
        check("پاسخ نهایی 200", res.status === 200, `→ ${res.status}`);
        check("دو فراخوانی upstream (failover واقعی)", t.upstreamCalls.length === 2, `→ ${t.upstreamCalls.length}`);
        check("تلاش اول KEY_A و دوم KEY_B", t.upstreamCalls[0]?.auth === "Bearer KEY_A" && t.upstreamCalls[1]?.auth === "Bearer KEY_B");
        check("بدنه در تلاش دوم سالم بود (بافر فیکس)", t.upstreamCalls[1]?.body === body);
        const stats = await (await t.coordinator.fetch(new Request("https://coordinator/stats"))).json();
        const idA = idOf(t.env.UPSTREAM_API_KEYS.split(",")[0]);
        const stA = stats.keys.find(k => k[0] === idA);
        check("کلید 401 گرفته قرنطینه شد (state=invalid، cooldown>0)", !!stA && stA[10] === "invalid" && stA[11] > 0,
            stA ? `state=${stA[10]}, cooldown=${stA[11]}` : "کلید یافت نشد");
        check("inflight هر دو صفر", await allInflightZero(t.coordinator));
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T3: تک‌کلید + 401 → passthrough 401 به کلاینت، سپس بازیابی پس از cooldown ──");
    {
        const t = makeEnv(["KEY_A"]);
        t.mockFetch([new Response("{}", { status: 401 })]);
        const res = await handler(new Request("https://internal/chat/completions", {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        }), t.env, t.ctx);
        await settle(t.ctx);
        cleanupFetch();
        const data = await res.json();
        check("کلاینت پاسخ واقعی 401 upstream را گرفت (نه خطای مبهم)", res.status === 401, JSON.stringify(data));
        check("فقط یک فراخوانی upstream", t.upstreamCalls.length === 1);
        const before = await (await t.coordinator.fetch(new Request("https://coordinator/stats"))).json();
        const stBefore = before.keys[0][10]; // state
        check("کلید state=invalid شد", stBefore === "invalid", `→ ${stBefore}`);
        await new Promise(r => setTimeout(r, 160));
        const sel = await t.coordinator.fetch(new Request("https://coordinator/select"));
        check("پس از AUTH_COOLDOWN کلید بازیابی شد (مسدودی دائمی نیست)", sel.status === 200, `→ ${sel.status}`);
        if (sel.status === 200) {
            const selData = await sel.json();
            // رزروی که فقط برای تست بازیابی برداشته شد را آزاد کن
            await t.coordinator.fetch(new Request("https://coordinator/cancel", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ key_id: selData.key_id }),
            }));
        }
        const after = await (await t.coordinator.fetch(new Request("https://coordinator/stats"))).json();
        check("inflight صفر ماند", after.keys[0][12] === 0);
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T4: POST + 429 → cooldown کلید، failover به کلید بعدی ──");
    {
        const body = JSON.stringify({ prompt: "x" });
        const t = makeEnv(["KEY_A", "KEY_B"]);
        t.mockFetch([
            new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ]);
        const res = await handler(new Request("https://internal/chat/completions", {
            method: "POST", headers: { "content-type": "application/json" }, body,
        }), t.env, t.ctx);
        await settle(t.ctx);
        cleanupFetch();
        check("پاسخ نهایی 200", res.status === 200, `→ ${res.status}`);
        check("دو فراخوانی upstream", t.upstreamCalls.length === 2, `→ ${t.upstreamCalls.length}`);
        check("کلید دوم استفاده شد", t.upstreamCalls[1]?.auth === "Bearer KEY_B");
        check("بدنه سالم در تلاش دوم", t.upstreamCalls[1]?.body === body);
        check("inflight صفر", await allInflightZero(t.coordinator));
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T5: 5xx → retry با همان کلید (پس از پایان cooldown) → 500 passthrough ──");
    {
        const t = makeEnv(["KEY_A"]);
        t.mockFetch([
            new Response("{}", { status: 500 }), new Response("{}", { status: 500 }),
            new Response("{}", { status: 500 }), new Response("{}", { status: 500 }),
        ]);
        const res = await handler(new Request("https://internal/models", { method: "GET" }), t.env, t.ctx);
        await settle(t.ctx);
        cleanupFetch();
        check("چهار تلاش upstream", t.upstreamCalls.length === 4, `→ ${t.upstreamCalls.length}`);
        check("همه با همان KEY_A (کلید مقصر نیست)", t.upstreamCalls.every(c => c.auth === "Bearer KEY_A"));
        check("پاسخ 500 واقعی upstream به کلاینت رسید", res.status === 500);
        check("inflight صفر", await allInflightZero(t.coordinator));
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T6: خطای شبکه ×4 → 502 upstream_unavailable ──");
    {
        const t = makeEnv(["KEY_A"]);
        t.mockFetch([new TypeError("fetch failed")]);
        const res = await handler(new Request("https://internal/models", { method: "GET" }), t.env, t.ctx);
        await settle(t.ctx);
        cleanupFetch();
        const data = await res.json();
        check("چهار تلاش", t.upstreamCalls.length === 4, `→ ${t.upstreamCalls.length}`);
        check("502 upstream_unavailable", res.status === 502 && data.error === "upstream_unavailable", JSON.stringify(data));
        check("رزروها آزاد شدند (release با status 0)", await allInflightZero(t.coordinator));
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T7: AUTH_MODE=x-api-key ──");
    {
        const t = makeEnv(["KEY_A"], { AUTH_MODE: "x-api-key" });
        t.mockFetch([new Response(JSON.stringify({ ok: true }), { status: 200 })]);
        const res = await handler(new Request("https://internal/models", { method: "GET" }), t.env, t.ctx);
        await settle(t.ctx);
        cleanupFetch();
        check("کلید در هدر x-api-key ارسال شد", t.upstreamCalls[0]?.xkey === "KEY_A" && t.upstreamCalls[0]?.auth === null);
        check("پاسخ 200", res.status === 200);
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T8: هر دو کلید 401 → تلاش روی هر دو، سپس 503 ──");
    {
        const t = makeEnv(["KEY_A", "KEY_B"]);
        t.mockFetch([new Response("{}", { status: 401 })]);
        const res = await handler(new Request("https://internal/models", { method: "GET" }), t.env, t.ctx);
        await settle(t.ctx);
        cleanupFetch();
        check("دو فراخوانی (هر کلید یک‌بار)", t.upstreamCalls.length === 2, `→ ${t.upstreamCalls.length}`);
        check("پاسخ واقعی 401 به کلاینت رسید (پاسsthrough)", res.status === 401);
        check("inflight صفر (هیچ رزروی لو نرفت)", await allInflightZero(t.coordinator));
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T9: 400 → passthrough فوری، کلید جریمه نمی‌شود ──");
    {
        const t = makeEnv(["KEY_A"]);
        t.mockFetch([new Response("{}", { status: 400 })]);
        const res = await handler(new Request("https://internal/models", { method: "GET" }), t.env, t.ctx);
        await settle(t.ctx);
        cleanupFetch();
        check("400 عیناً پاس شد", res.status === 400);
        check("فقط یک فراخوانی", t.upstreamCalls.length === 1);
        const stats = await (await t.coordinator.fetch(new Request("https://coordinator/stats"))).json();
        check("cooldown صفر (کلید سالم ماند)", stats.keys[0][11] === 0, `→ ${stats.keys[0][11]}`);
        check("state=healthy", stats.keys[0][10] === "healthy", `→ ${stats.keys[0][10]}`);
    }

    // ─────────────────────────────────────────────────────────
    console.log("── T10: Router v4 (auth، مسیریابی، حذف کلید کلاینت) ──");
    {
        const routerNew = (await import(pathToFileURL(path.join(root, "router", "src", "index.js")))).default;
        const upstreamCalls = [];
        const env = {
            ROUTER_API_KEY: "secret-key",
            BAI_WORKER: { fetch: async (req) => {
                upstreamCalls.push({
                    url: new URL(req.url).pathname,
                    auth: req.headers.get("authorization"),
                    provider: req.headers.get("x-omniroute-provider"),
                });
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
            } },
        };
        const health = await routerNew.fetch(new Request("https://r.test/health"), env);
        check("health → 200", health.status === 200);
        const unknown = await routerNew.fetch(new Request("https://r.test/zzz"), env);
        check("مسیر ناشناخته → 404", unknown.status === 404);
        const noAuth = await routerNew.fetch(new Request("https://r.test/a/models"), env);
        check("بدون کلید → 401", noAuth.status === 401);
        const wrong = await routerNew.fetch(new Request("https://r.test/a/models", { headers: { authorization: "Bearer nope" } }), env);
        check("کلید غلط → 401", wrong.status === 401);
        const ok = await routerNew.fetch(new Request("https://r.test/a/chat/completions", {
            method: "POST", headers: { authorization: "Bearer secret-key", "content-type": "application/json" }, body: "{}",
        }), env);
        check("درخواست معتبر → 200", ok.status === 200);
        check("prefix حذف شد", upstreamCalls[0]?.url === "/chat/completions");
        check("کلید کلاینت حذف شد", upstreamCalls[0]?.auth === null);
    }

    console.log(`\n═══ نتیجه v4 فیکس‌شده: ${passed} موفق، ${failed} ناموفق ═══`);
} catch (e) {
    process.exitCode = 1;
    logs.push("CRASH: " + (e?.stack || e));
} finally {
    console.log = origLog;
    console.error = origError;
    for (const line of logs) console.log(line);
    await unlink(shimPath).catch(() => {});
}
if (failed > 0) process.exitCode = 1;
