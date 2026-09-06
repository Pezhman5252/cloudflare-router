import { DurableObject } from "cloudflare:workers";

const DEFAULTS = {
  timeout: 25000,
  maxAttempts: 4,
  backoff: 350,
  maxBackoff: 60000,
  maxRetryTime: 15000,
  maxBodyBytes: 10 * 1024 * 1024,
  authCooldown: 900000,
  forbiddenCooldown: 900000,
  rateCooldown: 30000,
  transientCooldown: 5000,
  maxCooldown: 15 * 60 * 1000,
  dailyTokenLimit: 0,
  monthlyTokenLimit: 0,
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

function parseKeys(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];

  // Preferred format: JSON array, which safely supports keys containing commas.
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map(v => String(v).trim()).filter(Boolean))];
      }
    } catch {}
  }

  // Recommended human-readable format is one key per line or semicolon-separated.
  // Keep comma parsing as a backward-compatible fallback for existing deployments.
  const delimiter = raw.includes("\n") || raw.includes(";") ? /[;\n]+/ : /,/;
  return [...new Set(raw.split(delimiter).map(s => s.trim()).filter(Boolean))];
}

async function keyId(key) {
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `k_${hex}`;
}

function validId(v) {
  return !!v && /^[A-Za-z0-9._:=+@-]{1,128}$/.test(v);
}

function getRetryAfter(response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(level, message, ...args) {
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  (level === "error" ? console.error : console.log)(prefix, message, ...args);
}

function cfgNumber(env, name, fallback, minimum = 0) {
  const n = Number(env?.[name]);
  return Number.isFinite(n) && n >= minimum ? n : fallback;
}

function runtimeConfig(env, custom = {}) {
  return {
    timeout: cfgNumber(env, "UPSTREAM_TIMEOUT_MS", custom.timeout ?? DEFAULTS.timeout, 1),
    maxAttempts: Math.max(1, Math.floor(cfgNumber(env, "MAX_ATTEMPTS", custom.maxAttempts ?? DEFAULTS.maxAttempts, 1))),
    backoff: cfgNumber(env, "BACKOFF_MS", custom.backoff ?? DEFAULTS.backoff),
    maxBackoff: cfgNumber(env, "MAX_BACKOFF_MS", custom.maxBackoff ?? DEFAULTS.maxBackoff),
    maxRetryTime: cfgNumber(env, "MAX_RETRY_TIME_MS", custom.maxRetryTime ?? DEFAULTS.maxRetryTime),
    maxBodyBytes: cfgNumber(env, "MAX_BODY_BYTES", custom.maxBodyBytes ?? DEFAULTS.maxBodyBytes, 1),
    authCooldown: cfgNumber(env, "AUTH_COOLDOWN_MS", custom.authCooldown ?? DEFAULTS.authCooldown),
    forbiddenCooldown: cfgNumber(env, "FORBIDDEN_COOLDOWN_MS", custom.forbiddenCooldown ?? DEFAULTS.forbiddenCooldown),
    rateCooldown: cfgNumber(env, "RATE_COOLDOWN_MS", custom.rateCooldown ?? DEFAULTS.rateCooldown),
    transientCooldown: cfgNumber(env, "TRANSIENT_COOLDOWN_MS", custom.transientCooldown ?? DEFAULTS.transientCooldown),
    maxCooldown: cfgNumber(env, "MAX_COOLDOWN_MS", custom.maxCooldown ?? DEFAULTS.maxCooldown),
    dailyTokenLimit: cfgNumber(env, "DAILY_TOKEN_LIMIT", custom.dailyTokenLimit ?? DEFAULTS.dailyTokenLimit),
    monthlyTokenLimit: cfgNumber(env, "MONTHLY_TOKEN_LIMIT", custom.monthlyTokenLimit ?? DEFAULTS.monthlyTokenLimit),
  };
}

function dayStart(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function monthStart(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function isSuccessfulStatus(status) {
  return status >= 200 && status < 400;
}

function isRetryable(status) {
  return RETRYABLE_STATUSES.has(status) || AUTH_FAILURE_STATUSES.has(status);
}

function isTransient(status) {
  return status === 0 || status === 408 || status === 425 || (status >= 500 && status <= 599);
}

function isStreamResponse(response) {
  return (response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
}

function responseHeaders(response, reqId) {
  const headers = new Headers(response.headers);
  // An upstream must never be able to set cookies on the gateway's origin.
  headers.delete("set-cookie");
  headers.set("x-request-id", reqId);
  headers.set("cache-control", "no-store");
  return headers;
}

function finalizeResponse(response, reqId) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response, reqId),
  });
}

function errorResponse(message, status, reqId, extra = {}) {
  return Response.json({ error: message, ...(reqId ? { request_id: reqId } : {}) }, {
    status,
    headers: { "cache-control": "no-store", ...(reqId ? { "x-request-id": reqId } : {}), ...extra },
  });
}

function normalizeUsage(usage, fallbackTotal = null) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens);
  const output = Number(usage.output_tokens ?? usage.completion_tokens);
  const total = Number(usage.total_tokens ?? fallbackTotal ?? ((Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)));
  const hasAny = [input, output, total].some(Number.isFinite);
  if (!hasAny) return null;
  return {
    input_tokens: Number.isFinite(input) ? Math.max(0, input) : 0,
    output_tokens: Number.isFinite(output) ? Math.max(0, output) : 0,
    total_tokens: Number.isFinite(total) ? Math.max(0, total) : 0,
  };
}

async function extractUsage(response) {
  try {
    const data = await response.clone().json();
    const usage = normalizeUsage(data?.usage ?? data?.token_usage, data?.total_tokens);
    if (usage) return usage;
  } catch {}

  const headerValue = response.headers.get("x-token-usage");
  const headerTotal = Number(headerValue);
  if (headerValue !== null && headerValue !== "" && Number.isFinite(headerTotal) && headerTotal >= 0) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: headerTotal };
  }
  return null;
}

function parseSseLine(line) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trimStart();
  if (!payload || payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload);
    return normalizeUsage(json?.usage ?? json?.response?.usage, json?.total_tokens);
  } catch {
    return null;
  }
}

function mergeUsage(current, next) {
  if (!next) return current;
  return {
    input_tokens: (current?.input_tokens ?? 0) + (next.input_tokens ?? 0),
    output_tokens: (current?.output_tokens ?? 0) + (next.output_tokens ?? 0),
    total_tokens: (current?.total_tokens ?? 0) + (next.total_tokens ?? 0),
  };
}

function fullJitterDelay(base, attempt, max) {
  const cap = Math.min(max, base * (2 ** attempt));
  return Math.floor(Math.random() * (cap + 1));
}

function calculateRetryDelay(response, attempt, config, startedAt) {
  const retryAfter = getRetryAfter(response);
  const remaining = Math.max(0, config.maxRetryTime - (Date.now() - startedAt));
  if (remaining <= 0) return 0;
  const delay = retryAfter == null ? fullJitterDelay(config.backoff, attempt, config.maxBackoff) : Math.min(retryAfter, config.maxBackoff);
  return Math.min(delay, remaining);
}

function nextUtcMidnight(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 1000;
}

export class ApiKeyCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS keys (
          id TEXT PRIMARY KEY,
          total INTEGER NOT NULL DEFAULT 0,
          input INTEGER NOT NULL DEFAULT 0,
          output INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          success INTEGER NOT NULL DEFAULT 0,
          errors INTEGER NOT NULL DEFAULT 0,
          rate429 INTEGER NOT NULL DEFAULT 0,
          auth401 INTEGER NOT NULL DEFAULT 0,
          auth403 INTEGER NOT NULL DEFAULT 0,
          timeouts INTEGER NOT NULL DEFAULT 0,
          network_errors INTEGER NOT NULL DEFAULT 0,
          transient5xx INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          latency REAL NOT NULL DEFAULT 500,
          state TEXT NOT NULL DEFAULT 'healthy',
          cooldown INTEGER NOT NULL DEFAULT 0,
          inflight INTEGER NOT NULL DEFAULT 0,
          half_open_probe INTEGER NOT NULL DEFAULT 0,
          last_used INTEGER NOT NULL DEFAULT 0,
          last_success INTEGER NOT NULL DEFAULT 0,
          last_failure INTEGER NOT NULL DEFAULT 0,
          reserved_at INTEGER NOT NULL DEFAULT 0,
          day_start INTEGER NOT NULL DEFAULT 0,
          day_tokens INTEGER NOT NULL DEFAULT 0,
          day_requests INTEGER NOT NULL DEFAULT 0,
          day_known_requests INTEGER NOT NULL DEFAULT 0,
          month_start INTEGER NOT NULL DEFAULT 0,
          month_tokens INTEGER NOT NULL DEFAULT 0,
          month_requests INTEGER NOT NULL DEFAULT 0,
          known_usage_requests INTEGER NOT NULL DEFAULT 0,
          unknown_usage_requests INTEGER NOT NULL DEFAULT 0,
          circuit_open_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS window_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          day_start INTEGER NOT NULL,
          month_start INTEGER NOT NULL
        )
      `);
      const now = Date.now();
      const currentDay = dayStart(now);
      const currentMonth = monthStart(now);
      this.sql.exec(
        "INSERT OR IGNORE INTO window_meta(id, day_start, month_start) VALUES(1, ?, ?)",
        currentDay,
        currentMonth,
      );
      const existing = new Set([...this.sql.exec("PRAGMA table_info(keys)")].map(row => row.name));
      const additions = {
        auth401: "INTEGER NOT NULL DEFAULT 0",
        auth403: "INTEGER NOT NULL DEFAULT 0",
        timeouts: "INTEGER NOT NULL DEFAULT 0",
        network_errors: "INTEGER NOT NULL DEFAULT 0",
        transient5xx: "INTEGER NOT NULL DEFAULT 0",
        consecutive_failures: "INTEGER NOT NULL DEFAULT 0",
        half_open_probe: "INTEGER NOT NULL DEFAULT 0",
        day_start: "INTEGER NOT NULL DEFAULT 0",
        day_tokens: "INTEGER NOT NULL DEFAULT 0",
        day_requests: "INTEGER NOT NULL DEFAULT 0",
        day_known_requests: "INTEGER NOT NULL DEFAULT 0",
        month_start: "INTEGER NOT NULL DEFAULT 0",
        month_tokens: "INTEGER NOT NULL DEFAULT 0",
        month_requests: "INTEGER NOT NULL DEFAULT 0",
        known_usage_requests: "INTEGER NOT NULL DEFAULT 0",
        unknown_usage_requests: "INTEGER NOT NULL DEFAULT 0",
        circuit_open_count: "INTEGER NOT NULL DEFAULT 0",
        reserved_at: "INTEGER NOT NULL DEFAULT 0",
      };
      for (const [name, definition] of Object.entries(additions)) {
        if (!existing.has(name)) this.sql.exec(`ALTER TABLE keys ADD COLUMN ${name} ${definition}`);
      }

      // Small, targeted indexes for the coordinator's eligibility filters.
      // We intentionally avoid one index per ORDER BY expression: those indexes
      // would add write amplification without materially helping the scoring
      // expressions.
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_keys_state_cooldown ON keys(state, cooldown)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_keys_quota ON keys(day_tokens, month_tokens)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_keys_inflight_last_used ON keys(inflight, last_used)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_keys_failures ON keys(consecutive_failures)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_keys_reserved_at ON keys(reserved_at)`);

      if (typeof ctx.storage.setAlarm === "function") {
        await ctx.storage.setAlarm(nextUtcMidnight(Date.now()));
      }
    });
  }

  async alarm() {
    const now = Date.now();
    this.resetWindows(now);
    if (typeof this.ctx?.storage?.setAlarm === "function") {
      await this.ctx.storage.setAlarm(nextUtcMidnight(now));
    }
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);
    try {
      if (action === "select") return this.select(await request.json().catch(() => ({})));
      if (action === "release") return this.release(await request.json());
      if (action === "cancel") return this.cancel(await request.json());
      if (action === "stats") return this.stats();
      return Response.json({ error: "unknown_coordinator_action" }, { status: 404 });
    } catch (error) {
      log("error", `Coordinator ${action} failed`, error?.stack || error);
      return Response.json({ error: "coordinator_error" }, { status: 500 });
    }
  }

  async sync() {
    const keys = parseKeys(this.env.UPSTREAM_API_KEYS);
    const allowed = new Set();
    for (const key of keys) allowed.add(await keyId(key));
    for (const kid of allowed) this.sql.exec("INSERT OR IGNORE INTO keys(id) VALUES(?)", kid);
    const existing = [...this.sql.exec("SELECT id FROM keys").raw()].map(r => r[0]);
    for (const kid of existing) if (!allowed.has(kid)) this.sql.exec("DELETE FROM keys WHERE id=? AND inflight=0", kid);
    return keys;
  }

  resetWindows(now) {
    const day = dayStart(now);
    const month = monthStart(now);
    const meta = [...this.sql.exec("SELECT day_start, month_start FROM window_meta WHERE id=1").raw()][0];
    const oldDay = Number(meta?.[0] ?? 0);
    const oldMonth = Number(meta?.[1] ?? 0);
    if (oldDay !== day) {
      this.sql.exec("UPDATE keys SET day_start=?, day_tokens=0, day_requests=0, day_known_requests=0", day);
    }
    if (oldMonth !== month) {
      this.sql.exec("UPDATE keys SET month_start=?, month_tokens=0, month_requests=0", month);
    }
    if (oldDay !== day || oldMonth !== month) {
      this.sql.exec("UPDATE window_meta SET day_start=?, month_start=? WHERE id=1", day, month);
    }
  }

  async select(data = {}) {
    const keys = await this.sync();
    const map = new Map();
    for (const key of keys) map.set(await keyId(key), key);
    const now = Date.now();
    const config = runtimeConfig(this.env);
    this.resetWindows(now);

    // Stuck-reservation recovery. Every select stamps reserved_at, so a worker
    // that dies between select and release cannot pin a key forever: a
    // forgotten half_open_probe would deadlock the key (no further probe is
    // ever granted) and a stranded inflight reservation would skew load
    // balancing and block removal of a rotated key. The lease is deliberately
    // long — well beyond UPSTREAM_TIMEOUT_MS and any legitimate SSE stream —
    // so live reservations are never disturbed.
    const lease = Math.max(config.timeout + config.maxRetryTime + 60000, config.maxCooldown);
    this.sql.exec(`
      UPDATE keys
      SET inflight=CASE WHEN inflight>0 THEN 0 ELSE inflight END,
          half_open_probe=0,
          state=CASE WHEN half_open_probe>0 THEN 'open' ELSE state END
      WHERE reserved_at>0 AND reserved_at<? AND (inflight>0 OR half_open_probe>0)
    `, now - lease);

    const day = dayStart(now);
    const month = monthStart(now);
    const exclude = Array.isArray(data.exclude) ? data.exclude.filter(validId) : [];
    const allowDegraded = Boolean(data.allow_degraded);
    const allowHalfOpen = Boolean(data.allow_half_open);
    const placeholders = exclude.map(() => "?").join(",");
    const excludedSql = exclude.length ? `AND id NOT IN (${placeholders})` : "";
    const allowedIds = [...map.keys()];
    const allowedPlaceholders = allowedIds.map(() => "?").join(",");
    const allowedSql = allowedIds.length ? `AND id IN (${allowedPlaceholders})` : "AND 1=0";

    // A key in cooldown is never selected for a new attempt, except when it is
    // eligible for a single HALF_OPEN probe after cooldown expiry.
    let rows = [...this.sql.exec(`
      SELECT id, state, cooldown, inflight, day_tokens, month_tokens, day_requests,
             consecutive_failures, latency, last_used, half_open_probe
      FROM keys
      WHERE (cooldown = 0 OR cooldown <= ?)
        ${excludedSql}
        ${allowedSql}
        AND (? = 0 OR day_tokens < ?)
        AND (? = 0 OR month_tokens < ?)
        AND (
          state = 'healthy'
          OR (state = 'degraded' AND ? = 1)
          OR (state = 'open' AND ? = 1)
          OR state IN ('invalid','rate_limited')
        )
      ORDER BY
        CASE WHEN state = 'healthy' THEN 0 ELSE 1 END ASC,
        CASE WHEN ? > 0 THEN MIN(1.0, day_tokens * 1.0 / ?) ELSE 0 END ASC,
        CASE WHEN ? > 0 THEN MIN(1.0, month_tokens * 1.0 / ?) ELSE 0 END ASC,
        (inflight * 0.08) ASC,
        (MIN(1.0, consecutive_failures / 5.0) * 0.20) ASC,
        (MIN(1.0, latency / 10000.0) * 0.10) ASC,
        last_used ASC
      LIMIT 1
    `, now, ...exclude, ...allowedIds,
       config.dailyTokenLimit > 0 ? 1 : 0, config.dailyTokenLimit,
       config.monthlyTokenLimit > 0 ? 1 : 0, config.monthlyTokenLimit,
       allowDegraded ? 1 : 0, allowHalfOpen ? 1 : 0,
       config.dailyTokenLimit, Math.max(1, config.dailyTokenLimit),
       config.monthlyTokenLimit, Math.max(1, config.monthlyTokenLimit)).raw()];

    if (!rows.length && allowDegraded && validId(data.retry_key) && map.has(data.retry_key)) {
      rows = [...this.sql.exec(`
        SELECT id, state, cooldown, inflight, day_tokens, month_tokens, day_requests,
               consecutive_failures, latency, last_used, half_open_probe
        FROM keys
        WHERE id=? AND (cooldown=0 OR cooldown<=?)
          AND (?=0 OR day_tokens<?) AND (?=0 OR month_tokens<?)
          AND state IN ('degraded','open')
          AND half_open_probe=0
        LIMIT 1
      `, data.retry_key, now,
         config.dailyTokenLimit > 0 ? 1 : 0, config.dailyTokenLimit,
         config.monthlyTokenLimit > 0 ? 1 : 0, config.monthlyTokenLimit).raw()];
    }
    if (!rows.length) return Response.json({ error: "no_healthy_api_key" }, { status: 503 });

    // Selected row columns: 0=id 1=state 2=cooldown 10=half_open_probe.
    const row = rows[0];
    const kid = row[0];
    const state = String(row[1]);
    const cooldown = Number(row[2]);
    const halfOpenProbe = Number(row[10]);
    const isProbe = (state === "open" || state === "invalid" || state === "rate_limited") && cooldown <= now;
    const isHalfOpen = isProbe && (state === "open" ? allowHalfOpen : true);
    if (isHalfOpen && halfOpenProbe > 0) return Response.json({ error: "no_healthy_api_key" }, { status: 503 });

    const nextState = isHalfOpen ? "half_open" : state;
    this.sql.exec(`
      UPDATE keys SET
        inflight=inflight+1,
        requests=requests+1,
        last_used=?,
        reserved_at=?,
        state=?,
        half_open_probe=?
      WHERE id=?
    `, now, now, nextState, isHalfOpen ? 1 : 0, kid);

    return Response.json({ key_id: kid, api_key: map.get(kid), day_start: day, month_start: month });
  }

  async release(data = {}) {
    const kid = String(data.key_id || "");
    const row = [...this.sql.exec(`SELECT latency, failures, consecutive_failures, state, cooldown, half_open_probe FROM keys WHERE id=?`, kid).raw()][0];
    if (!row) return Response.json({ error: "unknown_key_id" }, { status: 404 });

    const now = Date.now();
    const status = Number(data.status || 0);
    const latency = Math.max(1, Number(data.latency_ms || 1));
    const input = Math.max(0, Number(data.input_tokens || 0));
    const output = Math.max(0, Number(data.output_tokens || 0));
    const total = Math.max(0, Number(data.total_tokens || input + output));
    const usageKnown = data.usage_known !== false && data.usage_known !== undefined ? Boolean(data.usage_known) : false;
    const retryAfter = Number.isFinite(Number(data.retry_after_ms)) ? Math.max(0, Number(data.retry_after_ms)) : null;
    const config = runtimeConfig(this.env);
    const errorType = String(data.error_type || "");
    const ok = isSuccessfulStatus(status);
    const transient = isTransient(status);
    const auth401 = status === 401;
    const auth403 = status === 403;
    const rate429 = status === 429;
    let state = "healthy";
    let cooldown = 0;
    let failures = Number(row[1]);
    let consecutive = Number(row[2]);
    let circuitOpenCount = 0;
    let halfOpenProbe = 0;

    if (ok) {
      consecutive = 0;
      state = "healthy";
    } else {
      failures += 1;
      consecutive += 1;
      if (auth401) {
        state = "invalid";
        cooldown = now + config.authCooldown;
      } else if (auth403) {
        state = "degraded";
        cooldown = now + config.forbiddenCooldown;
      } else if (rate429) {
        state = "rate_limited";
        const wait = Math.min(config.maxCooldown, Math.max(config.rateCooldown, retryAfter ?? config.rateCooldown));
        cooldown = now + wait;
      } else if (transient) {
        state = consecutive >= 3 ? "open" : "degraded";
        cooldown = now + Math.min(config.maxCooldown, config.transientCooldown);
        if (state === "open") circuitOpenCount = 1;
      } else {
        state = "healthy";
      }
    }

    if (String(row[3]) === "half_open" && ok) {
      state = "healthy";
      halfOpenProbe = 0;
    }
    if (state !== "open") halfOpenProbe = 0;

    const ema = Number(row[0]) * 0.8 + latency * 0.2;
    const dStart = dayStart(now);
    const mStart = monthStart(now);
    this.sql.exec(`
      UPDATE keys SET
        inflight=CASE WHEN inflight>0 THEN inflight-1 ELSE 0 END,
        total=total+?, input=input+?, output=output+?,
        success=success+?, errors=errors+?, rate429=rate429+?,
        auth401=auth401+?, auth403=auth403+?,
        timeouts=timeouts+?, network_errors=network_errors+?, transient5xx=transient5xx+?,
        failures=?, consecutive_failures=?, latency=?, state=?, cooldown=?, half_open_probe=?,
        reserved_at=0,
        last_success=CASE WHEN ? THEN ? ELSE last_success END,
        last_failure=CASE WHEN ? THEN ? ELSE last_failure END,
        day_start=?, day_tokens=day_tokens+?, day_requests=day_requests+1,
        day_known_requests=day_known_requests+?,
        month_start=?, month_tokens=month_tokens+?, month_requests=month_requests+1,
        known_usage_requests=known_usage_requests+?,
        unknown_usage_requests=unknown_usage_requests+?,
        circuit_open_count=circuit_open_count+?
      WHERE id=?
    `,
      total, input, output,
      ok ? 1 : 0, ok ? 0 : 1, rate429 ? 1 : 0,
      auth401 ? 1 : 0, auth403 ? 1 : 0,
      (errorType === "timeout" || status === 408 || status === 425) ? 1 : 0,
      (errorType === "network" || (status === 0 && errorType !== "timeout")) ? 1 : 0,
      status >= 500 && status <= 599 ? 1 : 0,
      failures, consecutive, ema, state, cooldown, halfOpenProbe,
      ok ? 1 : 0, now, !ok ? 1 : 0, now,
      dStart, usageKnown ? total : 0, usageKnown ? 1 : 0,
      mStart, usageKnown ? total : 0,
      usageKnown ? 1 : 0, usageKnown ? 0 : 1,
      circuitOpenCount,
      kid
    );
    return Response.json({ ok: true });
  }

  async cancel(data = {}) {
    const kid = String(data.key_id || "");
    this.sql.exec(`UPDATE keys SET inflight=CASE WHEN inflight>0 THEN inflight-1 ELSE 0 END, half_open_probe=0, reserved_at=0 WHERE id=?`, kid);
    return Response.json({ ok: true });
  }

  async stats() {
    await this.sync();
    const rows = [...this.sql.exec(`
      SELECT id,total,input,output,requests,success,errors,rate429,auth401,auth403,
             timeouts,network_errors,transient5xx,failures,consecutive_failures,latency,state,
             cooldown,inflight,half_open_probe,last_used,last_success,last_failure,
             day_start,day_tokens,day_requests,day_known_requests,month_start,month_tokens,
             month_requests,known_usage_requests,unknown_usage_requests,circuit_open_count
      FROM keys ORDER BY day_tokens ASC, total ASC
    `).raw()];
    return Response.json({ keys: rows });
  }
}

class BodyTooLargeError extends Error {
  constructor(limit) {
    super("request_body_too_large");
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

async function readBoundedBody(request, maxBytes) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body limit exceeded").catch(() => {});
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(chunk.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function upstream(request, url, key, reqId, attempt, timeout, bodyBuffer, authMode) {
  const headers = new Headers(request.headers);
  // Credentials (never forward the client's or the router's identity), DO
  // routing artifacts, conditional-request headers (a cached 304 upstream would
  // bypass the body and poison usage extraction), and request-modification
  // headers that would corrupt or clip the replayed body on retry.
  for (const header of [
    "authorization", "x-api-key", "x-auth-token", "x-router-api-key", "x-omniroute-provider",
    "host", "content-length", "cf-connecting-ip", "x-forwarded-for", "x-real-ip", "cf-worker",
    // hop-by-hop
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
    // conditional request
    "if-modified-since", "if-none-match", "if-match", "if-unmodified-since", "if-range",
    // request-modification
    "range", "expect"
  ]) headers.delete(header);
  if (authMode === "x-api-key") headers.set("x-api-key", key);
  else headers.set("authorization", `Bearer ${key}`);
  headers.set("x-request-id", reqId);
  headers.set("x-provider-attempt", String(attempt + 1));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(new Request(url, {
      method: request.method,
      headers,
      body: bodyBuffer ? bodyBuffer.slice(0) : undefined,
      redirect: "follow",
      signal: controller.signal,
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function releaseKey(coord, data) {
  return coord.fetch("https://coordinator/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

function streamResponse(response, coord, keyIdValue, start, reqId, waitUntil) {
  if (!response.body) return finalizeResponse(response, reqId);
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  let released = false;
  const retryAfter = getRetryAfter(response);

  const release = () => {
    if (released) return Promise.resolve();
    released = true;
    const known = Boolean(usage);
    return releaseKey(coord, {
      key_id: keyIdValue,
      status: response.status,
      latency_ms: Date.now() - start,
      ...(usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
      usage_known: known,
      retry_after_ms: retryAfter,
    }).catch(error => log("error", "stream release failed", error?.message || error));
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) usage = mergeUsage(usage, parseSseLine(line));
    },
    async flush() {
      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) usage = mergeUsage(usage, parseSseLine(line));
      await release();
    },
  });

  const pump = response.body.pipeTo(transform.writable).catch(error => release().then(() => { throw error; }));
  waitUntil(pump.catch(() => {}));
  return new Response(transform.readable, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response, reqId),
  });
}

export function createFetchHandler(customConfig = {}) {
  return async function handler(request, env, ctx) {
    if (!env.UPSTREAM_BASE_URL || !env.UPSTREAM_API_KEYS || !env.KEY_COORDINATOR) {
      return errorResponse("provider_not_configured", 500);
    }
    const config = runtimeConfig(env, customConfig);
    const authMode = String(env.AUTH_MODE || customConfig.authMode || "bearer").toLowerCase();
    const waitUntil = promise => {
      if (ctx?.waitUntil) ctx.waitUntil(Promise.resolve(promise).catch(() => {}));
      else Promise.resolve(promise).catch(() => {});
    };
    const url = new URL(request.url);
    const reqIdHeader = request.headers.get("x-request-id");
    const reqId = validId(reqIdHeader) ? reqIdHeader : crypto.randomUUID();
    const base = String(env.UPSTREAM_BASE_URL).replace(/\/+$/, "");
    const coord = env.KEY_COORDINATOR.getByName("global");

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > config.maxBodyBytes) {
      return errorResponse("request_body_too_large", 413, reqId);
    }

    const hasBody = !["GET", "HEAD"].includes(request.method) && request.body !== null;
    let bodyBuffer = null;
    if (hasBody) {
      try {
        // Retries require a replayable body. We therefore buffer only up to the
        // configured hard limit, reading incrementally so an oversized/chunked
        // request can never force an unbounded allocation.
        bodyBuffer = await readBoundedBody(request, config.maxBodyBytes);
      } catch (error) {
        if (error?.name === "BodyTooLargeError") return errorResponse("request_body_too_large", 413, reqId);
        throw error;
      }
    }

    const tried = new Set();
    let lastResponse = null;
    let lastError = null;
    const started = Date.now();

    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
      if (Date.now() - started > config.maxRetryTime && attempt > 0) break;
      const select = await coord.fetch(new Request("https://coordinator/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          exclude: [...tried],
          allow_degraded: attempt > 0,
          allow_half_open: true,
          retry_key: attempt > 0 ? [...tried].at(-1) : null,
        }),
      }));
      if (!select.ok) {
        if (lastResponse) return finalizeResponse(lastResponse, reqId);
        const payload = await select.json().catch(() => ({}));
        return errorResponse(payload.error || "no_healthy_api_key", select.status, reqId);
      }
      const selected = await select.json();
      if (!selected.api_key || !selected.key_id) return errorResponse("no_additional_api_key_available", 503, reqId);
      const keyIdValue = selected.key_id;
      tried.add(keyIdValue);
      const start = Date.now();

      try {
        const response = await upstream(request, `${base}${url.pathname}${url.search}`, selected.api_key, reqId, attempt, config.timeout, bodyBuffer, authMode);
        lastResponse = response;

        // Only successful SSE responses are streamable. Error SSE responses must
        // enter the ordinary retry/failover pipeline.
        if (isStreamResponse(response) && isSuccessfulStatus(response.status)) {
          return streamResponse(response, coord, keyIdValue, start, reqId, waitUntil);
        }

        const usage = await extractUsage(response);
        await releaseKey(coord, {
          key_id: keyIdValue,
          status: response.status,
          latency_ms: Date.now() - start,
          ...(usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
          usage_known: Boolean(usage),
          retry_after_ms: getRetryAfter(response),
        }).catch(error => log("error", "release failed", error?.message || error));

        if (!isRetryable(response.status) || attempt + 1 >= config.maxAttempts) return finalizeResponse(response, reqId);

        let delay = calculateRetryDelay(response, attempt, config, started);
        if (AUTH_FAILURE_STATUSES.has(response.status) || response.status === 429) {
          // Key-specific failures should fail over immediately. Retry-After is
          // stored on the key and is enforced by the coordinator, not by
          // sleeping the whole request before trying another key.
          delay = 0;
        } else if (isTransient(response.status)) {
          delay = Math.max(delay, config.transientCooldown);
        }
        if (delay > 0) await sleep(Math.min(delay, Math.max(0, config.maxRetryTime - (Date.now() - started))));
      } catch (error) {
        lastError = error;
        await releaseKey(coord, {
          key_id: keyIdValue,
          status: 0,
          latency_ms: Date.now() - start,
          usage_known: false,
          error_type: error?.name === "AbortError" ? "timeout" : "network",
        }).catch(releaseError => log("error", "network release failed", releaseError?.message || releaseError));
        if (attempt + 1 >= config.maxAttempts) break;
        const remaining = config.maxRetryTime - (Date.now() - started);
        if (remaining <= 0) break;
        const retryDelay = Math.max(config.transientCooldown, fullJitterDelay(config.backoff, attempt, config.maxBackoff));
        await sleep(Math.min(retryDelay, remaining));
      }
    }

    if (lastResponse) return finalizeResponse(lastResponse, reqId);
    return errorResponse(lastError?.name === "AbortError" ? "upstream_timeout" : "upstream_unavailable", 502, reqId);
  };
}

export { keyId, parseKeys, getRetryAfter, normalizeUsage, runtimeConfig, isRetryable, readBoundedBody };
