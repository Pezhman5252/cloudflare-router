import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) { passed++; console.log(`✔ ${name}`); }
  else { failed++; console.error(`✘ ${name}${detail ? ` — ${detail}` : ""}`); }
}

class SQLCursor {
  constructor(columns, rows) { this.columns = columns; this.rows = rows; this.i = 0; }
  next() {
    if (this.i >= this.rows.length) return { done: true, value: undefined };
    const row = this.rows[this.i++];
    const obj = {};
    this.columns.forEach((c, i) => obj[c] = row[i]);
    return { done: false, value: obj };
  }
  [Symbol.iterator]() { return this; }
  toArray() { return [...this]; }
  one() { const a = this.toArray(); if (a.length !== 1) throw new Error("one() expected one row"); return a[0]; }
  raw() {
    const rows = this.rows.slice(this.i);
    this.i = this.rows.length;
    return rows[Symbol.iterator]();
  }
}

class SQLShim {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  exec(sql, ...params) {
    const trimmed = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(trimmed)) {
      throw new Error("transaction SQL is forbidden in the Cloudflare SQL API");
    }
    const stmt = this.db.prepare(trimmed);
    if (/^(SELECT|WITH|PRAGMA)\b/i.test(trimmed)) {
      const cols = stmt.columns().map(c => c.name);
      const all = stmt.all(...params);
      return new SQLCursor(cols, all.map(row => cols.map(c => row[c])));
    }
    stmt.run(...params);
    return new SQLCursor([], []);
  }
}

const nativeRequest = globalThis.Request;
globalThis.Request = class extends nativeRequest {
  constructor(input, init) {
    if (init?.body && typeof init.body === "object" && typeof init.body.pipeTo === "function" && !init.duplex) {
      init = { ...init, duplex: "half" };
    }
    super(input, init);
  }
};

const corePath = path.join(root, "common", "provider-core.js");
let source = await readFile(corePath, "utf8");
source = source.replace(
  'import { DurableObject } from "cloudflare:workers";',
  `export class DurableObject {
     constructor(ctx, env) { this.ctx = ctx; this.env = env; }
   }`
);
const shimPath = path.join(here, ".tmp-v5-core.mjs");
await writeFile(shimPath, source, "utf8");

const { createFetchHandler, ApiKeyCoordinator, keyId, parseKeys, runtimeConfig, readBoundedBody } = await import(pathToFileURL(shimPath));
const handler = createFetchHandler();

function makeCoordinator(env) {
  const coordinator = new ApiKeyCoordinator({
    storage: { sql: new SQLShim() },
    blockConcurrencyWhile(fn) { this._ready = Promise.resolve().then(fn); },
  }, env);
  const ready = coordinator.ctx?._ready ?? Promise.resolve();
  let queue = Promise.resolve();
  const api = {
    fetch(request, init) {
      const normalized = request instanceof Request ? request : new Request(request, init);
      const run = queue.then(async () => { await ready; return coordinator.fetch(normalized); });
      queue = run.catch(() => {});
      return run;
    },
  };
  return { coordinator, api };
}

function makeEnv(keys, overrides = {}) {
  const env = {
    UPSTREAM_BASE_URL: "https://upstream.test/v1",
    UPSTREAM_API_KEYS: keys.join(","),
    AUTH_MODE: "bearer",
    MAX_ATTEMPTS: "4",
    BACKOFF_MS: "1",
    MAX_BACKOFF_MS: "10",
    MAX_RETRY_TIME_MS: "1000",
    AUTH_COOLDOWN_MS: "30",
    FORBIDDEN_COOLDOWN_MS: "30",
    RATE_COOLDOWN_MS: "20",
    TRANSIENT_COOLDOWN_MS: "5",
    MAX_COOLDOWN_MS: "100",
    MAX_BODY_BYTES: "1048576",
    ...overrides,
  };
  const { coordinator, api } = makeCoordinator(env);
  const calls = [];
  const releases = [];
  const ctx = { tasks: [], waitUntil(p) { this.tasks.push(Promise.resolve(p).catch(() => {})); } };
  const fetchMock = async req => {
    const body = req.body === null ? null : await req.text();
    calls.push({
      authorization: req.headers.get("authorization"),
      apiKey: req.headers.get("x-api-key"),
      body,
      attempt: req.headers.get("x-provider-attempt"),
      connection: req.headers.get("connection"),
      expect: req.headers.get("expect"),
      ifNoneMatch: req.headers.get("if-none-match"),
      routerApiKey: req.headers.get("x-router-api-key"),
      xRequestId: req.headers.get("x-request-id"),
    });
    const script = env.__script;
    const step = script[Math.min(env.__index++, script.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return {
    env: { ...env, KEY_COORDINATOR: { getByName: () => api } },
    coordinator, calls, releases, ctx,
    async runScript(script) { env.__script = script; env.__index = 0; globalThis.fetch = fetchMock; },
    async settle() { await Promise.allSettled(ctx.tasks); },
  };
}

const savedFetch = globalThis.fetch;
async function stats(coordinator) {
  const res = await coordinator.fetch(new Request("https://coordinator/stats"));
  return (await res.json()).keys;
}
async function statFor(coordinator, key) {
  const id = await keyId(key);
  return (await stats(coordinator)).find(row => row[0] === id);
}
function inflightColumn(row) { return row[18]; }
function stateColumn(row) { return row[16]; }
function cooldownColumn(row) { return row[17]; }
function dayTokensColumn(row) { return row[24]; }
function unknownUsageColumn(row) { return row[31]; }

try {
  console.log("\nV5 local verification suite\n");

  // 1) SHA-256 identity is stable and 256-bit-derived.
  {
    const id = await keyId("KEY_A");
    check("SHA-256 key identity", /^k_[0-9a-f]{64}$/.test(id));
  }

  // 2) POST body replay + 401 failover.
  {
    const t = makeEnv(["KEY_A", "KEY_B"]);
    await t.runScript([
      new Response("invalid", { status: 401 }),
      new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const body = JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] });
    const response = await handler(new Request("https://internal/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "keep-alive",
        expect: "100-continue",
        "if-none-match": '"etag-1"',
        "x-router-api-key": "leak-me",
      },
      body,
    }), t.env, t.ctx);
    await t.settle();
    check("401 failover returns 200", response.status === 200);
    check("POST body replay is byte-identical", t.calls.length === 2 && t.calls[0].body === body && t.calls[1].body === body);
    check("failover changes API key", t.calls.length === 2 && t.calls[0]?.authorization !== t.calls[1]?.authorization);
    check("hop-by-hop and conditional headers are stripped upstream", t.calls.length === 2 && t.calls.every(c =>
      c.connection === null && c.expect === null && c.ifNoneMatch === null && c.routerApiKey === null));
    check("upstream authorization carries only provider keys", t.calls.length === 2 && t.calls.every(c =>
      typeof c.authorization === "string" && c.authorization.startsWith("Bearer KEY_")));
    const failedKey = t.calls[0]?.authorization?.replace(/^Bearer\s+/, "");
    const a = await statFor(t.coordinator, failedKey);
    check("401 key enters quarantine", !!a && stateColumn(a) === "invalid" && cooldownColumn(a) > Date.now());
    check("inflight is zero after release", (await stats(t.coordinator)).every(row => inflightColumn(row) === 0));
  }

  // 3) 429 uses another key immediately and does not retry the rate-limited key.
  {
    const t = makeEnv(["KEY_A", "KEY_B"]);
    await t.runScript([new Response("rate", { status: 429, headers: { "retry-after": "120" } }), new Response("ok", { status: 200 })]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("429 fails over immediately", response.status === 200 && t.calls.length === 2);
    check("429 second attempt uses different key", t.calls.length === 2 && t.calls[0].authorization !== t.calls[1].authorization);
    const rateKey = t.calls[0]?.authorization?.replace(/^Bearer\s+/, "");
    const a = await statFor(t.coordinator, rateKey);
    check("Retry-After is stored without truncating to maxBackoff", !!a && cooldownColumn(a) - Date.now() > 50);
  }

  // 4) Single transient key retries after its cooldown; no retry storm.
  {
    const t = makeEnv(["KEY_A"], { TRANSIENT_COOLDOWN_MS: "5" });
    await t.runScript([new Response("e", { status: 500 }), new Response("ok", { status: 200 })]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("single-key transient retry recovers", response.status === 200 && t.calls.length === 2);
    check("transient retry reuses same key", t.calls.every(x => x.authorization === "Bearer KEY_A"));
  }

  // 5) 3 transient failures open circuit; next request probes half-open after cooldown.
  {
    const t = makeEnv(["KEY_A"], { TRANSIENT_COOLDOWN_MS: "5", MAX_ATTEMPTS: "3" });
    await t.runScript([new Response("e", { status: 500 })]);
    const first = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("circuit opens after repeated transient failures", first.status === 500 && stateColumn(await statFor(t.coordinator, "KEY_A")) === "open");
    await new Promise(r => setTimeout(r, 25));
    await t.runScript([new Response("ok", { status: 200 })]);
    const second = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("half-open probe recovers circuit", second.status === 200 && stateColumn(await statFor(t.coordinator, "KEY_A")) === "healthy");
  }

  // 5b) A provider configured with exactly ONE key must behave honestly in every
  // failure class: auth errors surface the real upstream response, rate limits
  // surface the real 429 and self-heal after cooldown, quota exhaustion returns
  // a clean 503. No masked errors, no hammering a cooled-down key.
  {
    const t = makeEnv(["KEY_A"]);
    await t.runScript([new Response("no auth", { status: 401 })]);
    const auth = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("single-key 401 surfaces the upstream response and quarantines the key", auth.status === 401 && stateColumn(await statFor(t.coordinator, "KEY_A")) === "invalid");

    const t2 = makeEnv(["KEY_A"], { RATE_COOLDOWN_MS: "5" });
    await t2.runScript([new Response("rate", { status: 429 })]);
    const rate = await handler(new Request("https://internal/x"), t2.env, t2.ctx);
    await t2.settle();
    check("single-key 429 surfaces the upstream response", rate.status === 429 && t2.calls.length === 1);
    await new Promise(r => setTimeout(r, 30));
    await t2.runScript([new Response("ok", { status: 200 })]);
    const healed = await handler(new Request("https://internal/x"), t2.env, t2.ctx);
    await t2.settle();
    check("single-key 429 self-heals after cooldown via half-open probe", healed.status === 200 && stateColumn(await statFor(t2.coordinator, "KEY_A")) === "healthy");

    const t3 = makeEnv(["KEY_A"], { DAILY_TOKEN_LIMIT: "5" });
    await t3.runScript([new Response(JSON.stringify({ usage: { total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } })]);
    const first = await handler(new Request("https://internal/x"), t3.env, t3.ctx);
    await t3.settle();
    const second = await handler(new Request("https://internal/x"), t3.env, t3.ctx);
    await t3.settle();
    const body = await second.json();
    check("single-key daily quota exhaustion returns a clean 503 with reason", first.status === 200 && second.status === 503 && body.error === "no_healthy_api_key" && body.reason === "all_keys_in_cooldown_or_quota");
  }

  // 5c) The 503 no_healthy_api_key response must be self-explanatory: it names
  // the reason (cooldown vs. missing secret) and reports when the provider heals.
  {
    const t = makeEnv(["KEY_A"], { RATE_COOLDOWN_MS: "60000", MAX_COOLDOWN_MS: "60000" });
    await t.runScript([new Response("rate", { status: 429 })]);
    const first = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("single-key 429 surfaces the upstream response", first.status === 429);
    const second = await handler(new Request("https://internal/x"), t.env, t.ctx);
    const cooldownBody = await second.json();
    const retryAfterMs = Number(cooldownBody.retry_after_ms);
    check("cooldown 503 reports reason and remaining retry window", second.status === 503 && cooldownBody.reason === "all_keys_in_cooldown_or_quota" && retryAfterMs > 50000 && retryAfterMs <= 60000);

    const empty = makeEnv(["   "]);
    const missing = await handler(new Request("https://internal/x"), empty.env, empty.ctx);
    const missingBody = await missing.json();
    check("blank UPSTREAM_API_KEYS reports no_api_keys_configured", missing.status === 503 && missingBody.reason === "no_api_keys_configured");
  }

  // 6) SSE success streams unchanged and records usage even when split across chunks.
  {
    const t = makeEnv(["KEY_A"]);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":7,'));
        controller.enqueue(new TextEncoder().encode('"completion_tokens":3,"total_tokens":10}}\r\n\r\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\r\n\r\n'));
        controller.close();
      },
    });
    await t.runScript([new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const response = await handler(new Request("https://internal/stream"), t.env, t.ctx);
    const text = await response.text();
    await t.settle();
    check("successful SSE remains a stream response", response.status === 200 && text.includes('"total_tokens":10'));
    const row = await statFor(t.coordinator, "KEY_A");
    check("SSE usage is counted as known usage", dayTokensColumn(row) === 10 && unknownUsageColumn(row) === 0);
  }

  // 7) Multiple SSE usage events are additive (e.g. prompt event followed by completion event).
  {
    const t = makeEnv(["KEY_A"]);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":7}}\r\n\r\n'));
        controller.enqueue(new TextEncoder().encode('data: {"usage":{"completion_tokens":3}}\r\n\r\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\r\n\r\n'));
        controller.close();
      },
    });
    await t.runScript([new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const response = await handler(new Request("https://internal/stream"), t.env, t.ctx);
    await response.text();
    await t.settle();
    const row = await statFor(t.coordinator, "KEY_A");
    check("SSE usage events are summed", response.status === 200 && dayTokensColumn(row) === 10 && unknownUsageColumn(row) === 0);
  }

  // 7b) A hostile SSE upstream with an unterminated multi-megabyte line must not
  // grow the parser buffer without bound, and later usage events still count.
  {
    const t = makeEnv(["KEY_A"]);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(2000000)}`));
        controller.enqueue(new TextEncoder().encode('\n\ndata: {"usage":{"total_tokens":5}}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    await t.runScript([new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const response = await handler(new Request("https://internal/stream"), t.env, t.ctx);
    const text = await response.text();
    await t.settle();
    check("hostile unterminated SSE line is bounded and passthrough intact", response.status === 200 && text.includes('"total_tokens":5'));
    const row = await statFor(t.coordinator, "KEY_A");
    check("usage after a dropped remainder is still counted", dayTokensColumn(row) === 5 && unknownUsageColumn(row) === 0);
  }

  // 8) SSE error must NOT bypass failover.
  {
    const t = makeEnv(["KEY_A", "KEY_B"]);
    await t.runScript([
      new Response("error", { status: 429, headers: { "content-type": "text/event-stream" } }),
      new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);

    const response = await handler(new Request("https://internal/stream"), t.env, t.ctx);
    const text = await response.text();
    await t.settle();
    check("SSE error enters failover pipeline", response.status === 200 && text === "ok" && t.calls.length === 2);
  }

  // 9) Unknown usage is not counted as zero known usage.
  {
    const t = makeEnv(["KEY_A"]);
    await t.runScript([new Response("{}", { status: 200 })]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    const row = await statFor(t.coordinator, "KEY_A");
    check("unknown usage is distinct from zero usage", response.status === 200 && unknownUsageColumn(row) === 1 && dayTokensColumn(row) === 0);
  }

  // 10) Daily quota excludes an exhausted key from selection.
  {
    const t = makeEnv(["KEY_A", "KEY_B"], { DAILY_TOKEN_LIMIT: "10" });
    await t.runScript([
      new Response(JSON.stringify({ usage: { total_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    const second = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("daily quota causes next request to choose another key", second.status === 200 && t.calls.length === 2 && t.calls[0].authorization !== t.calls[1].authorization);
  }

  // 11) x-api-key auth mode.
  {
    const t = makeEnv(["KEY_A"], { AUTH_MODE: "x-api-key" });
    await t.runScript([new Response("ok", { status: 200 })]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("x-api-key mode sends correct header", response.status === 200 && t.calls[0].apiKey === "KEY_A" && t.calls[0].authorization === null);
  }

  // 12) Body-size enforcement catches missing content-length too.
  {
    const t = makeEnv(["KEY_A"], { MAX_BODY_BYTES: "4" });
    await t.runScript([new Response("should-not-call", { status: 200 })]);
    const response = await handler(new Request("https://internal/x", { method: "POST", body: "12345" }), t.env, t.ctx);
    check("body size is enforced after buffering", response.status === 413 && t.calls.length === 0);
  }

  // 13) Concurrent coordinator selection is serialized and never over-reserves the same key.
  {
    const env = { UPSTREAM_API_KEYS: "A,B", TRANSIENT_COOLDOWN_MS: "5" };
    const { coordinator, api } = makeCoordinator(env);
    const results = await Promise.all(Array.from({ length: 20 }, () => api.fetch(new Request("https://coordinator/select", { method: "POST", body: JSON.stringify({}) }))));
    const selected = await Promise.all(results.map(r => r.json()));
    check("concurrent selection returns valid unique IDs while excluding is caller-controlled", selected.every(x => x.key_id && x.api_key));
    const rows = await stats(coordinator);
    check("concurrent reservations remain balanced", rows.every(r => r[18] === 10));
  }

  // 14) Removed key with an in-flight reservation is retained until release, then removed.
  {
    const env = { UPSTREAM_API_KEYS: "A,B" };
    const { coordinator, api } = makeCoordinator(env);
    const selected = await (await api.fetch(new Request("https://coordinator/select", { method: "POST", body: "{}" }))).json();
    env.UPSTREAM_API_KEYS = "B";
    await api.fetch(new Request("https://coordinator/stats"));
    const retained = (await stats(coordinator)).some(row => row[0] === selected.key_id);
    await api.fetch(new Request("https://coordinator/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key_id: selected.key_id, status: 200, usage_known: false }) }));
    const removed = !(await stats(coordinator)).some(row => row[0] === selected.key_id);
    check("key rotation keeps in-flight key until release", retained && removed);
  }

  // 14b) A worker that dies between select and release cannot pin a key forever:
  // the lease GC clears the stuck half_open_probe so the circuit can recover.
  {
    const env = { UPSTREAM_API_KEYS: "A", TRANSIENT_COOLDOWN_MS: "5", MAX_COOLDOWN_MS: "100" };
    const { coordinator, api } = makeCoordinator(env);
    const first = await (await api.fetch(new Request("https://coordinator/select", { method: "POST", body: "{}" }))).json();
    // Drive the circuit open with three transient failures.
    for (let i = 0; i < 3; i++) {
      await api.fetch(new Request("https://coordinator/release", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key_id: first.key_id, status: 500, usage_known: false }),
      }));
    }
    await new Promise(r => setTimeout(r, 10)); // let the transient cooldown lapse
    const probe = await (await api.fetch(new Request("https://coordinator/select", { method: "POST", body: JSON.stringify({ allow_half_open: true }) }))).json();
    check("half-open probe is granted on an open circuit", !!probe.key_id);
    // The probe worker dies: backdate its lease beyond the GC threshold.
    coordinator.ctx.storage.sql.exec("UPDATE keys SET reserved_at = ?", Date.now() - 1000000);
    const recovered = await (await api.fetch(new Request("https://coordinator/select", { method: "POST", body: JSON.stringify({ allow_half_open: true }) }))).json();
    check("lease GC revives a stuck half-open probe", !!recovered.key_id && recovered.key_id === probe.key_id);
    const row = await statFor(coordinator, "A");
    check("recovered probe holds exactly one live reservation", stateColumn(row) === "half_open" && inflightColumn(row) === 1);
  }

  // 14c) Live reservations are never disturbed by the lease GC.
  {
    const env = { UPSTREAM_API_KEYS: "A,B" };
    const { coordinator, api } = makeCoordinator(env);
    const s1 = await (await api.fetch(new Request("https://coordinator/select", { method: "POST", body: "{}" }))).json();
    const s2 = await (await api.fetch(new Request("https://coordinator/select", { method: "POST", body: "{}" }))).json();
    const rows = await stats(coordinator);
    const live = rows.filter(row => [s1.key_id, s2.key_id].includes(row[0]));
    check("fresh reservations survive GC", live.length === 2 && live.every(row => inflightColumn(row) === 1));
  }

  // 15) 403 is quarantined and does not consume the next key.
  {
    const t = makeEnv(["A", "B"]);
    await t.runScript([new Response("forbidden", { status: 403 }), new Response("ok", { status: 200 })]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    const failedKey = t.calls[0].authorization.replace(/^Bearer\s+/, "");
    const row = await statFor(t.coordinator, failedKey);
    check("403 failover and quarantine", response.status === 200 && t.calls.length === 2 && stateColumn(row) === "degraded");
  }

  // 16) Client errors are passed through and do not quarantine the key.
  {
    const t = makeEnv(["A"]);
    await t.runScript([new Response("bad request", { status: 400 })]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    const row = await statFor(t.coordinator, "A");
    check("400 passthrough without key penalty", response.status === 400 && stateColumn(row) === "healthy" && cooldownColumn(row) === 0);
  }

  // 17) Network errors retry and release every reservation.
  {
    const t = makeEnv(["A"], { MAX_ATTEMPTS: "3", TRANSIENT_COOLDOWN_MS: "2" });
    await t.runScript([new TypeError("network failure")]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    const row = await statFor(t.coordinator, "A");
    check("network error retry budget is bounded", response.status === 502 && t.calls.length === 3 && inflightColumn(row) === 0);
  }

  // 18) HTTP-date Retry-After is parsed.
  {
    const t = makeEnv(["A", "B"]);
    const date = new Date(Date.now() + 5000).toUTCString();
    await t.runScript([new Response("rate", { status: 429, headers: { "retry-after": date } }), new Response("ok", { status: 200 })]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    const failedKey = t.calls[0].authorization.replace(/^Bearer\s+/, "");
    const row = await statFor(t.coordinator, failedKey);
    check("HTTP-date Retry-After is honored", response.status === 200 && cooldownColumn(row) > Date.now());
  }

  // 19) Legacy v4 schema is migrated without losing existing state.
  {
    const env = { UPSTREAM_API_KEYS: "A" };
    const sql = new SQLShim();
    sql.exec(`CREATE TABLE keys (id TEXT PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rate429 INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, latency REAL NOT NULL DEFAULT 500, state TEXT NOT NULL DEFAULT 'healthy', cooldown INTEGER NOT NULL DEFAULT 0, inflight INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0, last_success INTEGER NOT NULL DEFAULT 0, last_failure INTEGER NOT NULL DEFAULT 0)`);
    const oldId = await keyId("A");
    sql.exec("INSERT INTO keys(id,total,requests) VALUES(?,?,?)", oldId, 123, 7);
    const ctx = { storage: { sql }, blockConcurrencyWhile(fn) { this._ready = Promise.resolve().then(fn); } };
    const c = new ApiKeyCoordinator(ctx, env);
    await ctx._ready;
    const row = (await (await c.fetch(new Request("https://c/stats"))).json()).keys[0];
    check("legacy schema migrates and preserves counters", row[1] === 123 && row[4] === 7 && row.length >= 33);
    const indexes = [...sql.exec("PRAGMA index_list(keys)").raw()].map(r => r[1]);
    check("coordinator indexes are created", indexes.includes("idx_keys_state_cooldown") && indexes.includes("idx_keys_quota") && indexes.includes("idx_keys_inflight_last_used") && indexes.includes("idx_keys_failures"));
  }

  // 19) Configuration and bounded-body hardening.
  {
    const parsed = parseKeys('["key,with,commas","plain-key"]');
    const bracketQuoted = parseKeys("['key,with,commas','plain']");
    const bracketBare = parseKeys("[key1, key2]");
    const config = runtimeConfig({});
    const oversized = new Request("https://internal/upload", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
    });
    let rejected = false;
    try { await readBoundedBody(oversized, 10); } catch (error) { rejected = error?.name === "BodyTooLargeError"; }
    check("JSON key format preserves commas", parsed.length === 2 && parsed[0] === "key,with,commas");
    check("single-quoted bracket key list parses", bracketQuoted.length === 2 && bracketQuoted[0] === "key,with,commas" && bracketQuoted[1] === "plain");
    check("bare bracket key list parses", bracketBare.length === 2 && bracketBare[0] === "key1" && bracketBare[1] === "key2");
    check("default upstream timeout is 25 seconds", config.timeout === 25000);
    check("chunked body limit rejects before unbounded buffering", rejected);
  }

  // 20) Router authentication, routing and body forwarding.
  {
    const router = (await import(pathToFileURL(path.join(root, "router", "src", "index.js")))).default;
    const calls = [];
    const env = { ROUTER_API_KEY: "secret", BAI_WORKER: { fetch: async req => { calls.push(req); return new Response("ok", { status: 200 }); } } };
    const health = await router.fetch(new Request("https://router/health"), env);
    const unauthorized = await router.fetch(new Request("https://router/a/x"), env);
    const ok = await router.fetch(new Request("https://router/a/chat", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: "{}" }), env);
    check("router health is public", health.status === 200);
    check("router rejects missing auth", unauthorized.status === 401);
    check("router forwards authenticated request", ok.status === 200 && new URL(calls[0].url).pathname === "/chat" && calls[0].headers.get("authorization") === null);

    const oversizedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });
    const beforeOversizedCalls = calls.length;
    const oversized = await router.fetch(new Request("https://router/a/upload", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/octet-stream" },
      body: oversizedStream,
    }), { ...env, MAX_BODY_BYTES: "10" });
    check("router forwards chunked bodies without double buffering", oversized.status === 200 && calls.length === beforeOversizedCalls + 1);
    check("router leaves authoritative chunked size enforcement to provider", calls.at(-1)?.headers.get("content-length") === null);

    const chunked = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    const forwarded = await router.fetch(new Request("https://router/a/upload", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "text/plain" },
      body: chunked,
    }), { ...env, MAX_BODY_BYTES: "32" });
    const lastCall = calls.at(-1);
    check("router forwards chunked body without duplex dependency", forwarded.status === 200 && lastCall && await lastCall.text() === "hello world");

    const hopByHop = await router.fetch(new Request("https://router/a/x", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        connection: "keep-alive",
        expect: "100-continue",
        "x-forwarded-for": "203.0.113.9",
      },
      body: "ping",
    }), env);
    check("router strips hop-by-hop and identity headers before forwarding", hopByHop.status === 200 && calls.at(-1) &&
      calls.at(-1).headers.get("connection") === null &&
      calls.at(-1).headers.get("expect") === null &&
      calls.at(-1).headers.get("x-forwarded-for") === null &&
      calls.at(-1).headers.get("authorization") === null);

    const cookieWorker = {
      fetch: async () => new Response("ok", { status: 200, headers: { "set-cookie": "session=upstream" } }),
    };
    const withCookie = await router.fetch(new Request("https://router/a/x", { headers: { authorization: "Bearer secret" } }), { ...env, BAI_WORKER: cookieWorker });
    check("upstream set-cookie never reaches the client", withCookie.status === 200 && withCookie.headers.get("set-cookie") === null);

    const zeroLimit = await router.fetch(new Request("https://router/a/x", {
      method: "POST", headers: { authorization: "Bearer secret" }, body: "abc",
    }), { ...env, MAX_BODY_BYTES: "0" });
    check("router MAX_BODY_BYTES=0 falls back to the default limit", zeroLimit.status === 200);
  }

  // 21) Provider also strips upstream set-cookie (defense in depth).
  {
    const t = makeEnv(["KEY_A"]);
    await t.runScript([new Response("ok", { status: 200, headers: { "set-cookie": "sid=upstream" } })]);
    const response = await handler(new Request("https://internal/x"), t.env, t.ctx);
    await t.settle();
    check("provider strips upstream set-cookie", response.status === 200 && response.headers.get("set-cookie") === null);
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
} catch (error) {
  failed++;
  console.error(error?.stack || error);
} finally {
  globalThis.fetch = savedFetch;
  await unlink(shimPath).catch(() => {});
}

if (failed > 0) process.exitCode = 1;
