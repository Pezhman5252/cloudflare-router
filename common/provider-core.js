import { DurableObject } from "cloudflare:workers";

// ─────────────────────────────────────────────────────────────────────────────
// OmniRoute Provider Core (v4 — fixed)
//
// هسته‌ی مشترک هر دو Provider Worker:
//   - Durable Object (SQLite) برای هماهنگی کلیدها: رزرو اتمیک، inflight، آمار
//   - failover بین کلیدها روی 401/403/429/408/425/5xx/تایم‌اوت/خطای شبکه
//   - مدیریت صحیح استریم SSE (تک‌لوله‌ای) با استخراج usage از رویدادهای data:
//
// سه نکته‌ی حیاتی پیاده‌سازی (در نسخه‌های قبلی باگ بحرانی بودند):
//   ۱) بدنه‌ی درخواست یک‌بار و قبل از حلقه‌ی failover بافر می‌شود؛ استریم body
//      فقط یک‌بار قابل خواندن است و بدون این بافر، تلاش دوم با
//      «body disturbed» شکست می‌خورد و failover روی POST عملاً مرده است.
//   ۲) پاسخ SSE فقط یک‌بار pipe می‌شود: upstream → transform.writable (pump)
//      و transform.readable به کلاینت داده می‌شود. pipe کردن دوباره‌ی
//      resp.body استریم را قفل می‌کند و هر درخواست استریم را ۵۰۲ می‌کند.
//   ۳) API واقعی SQL در Durable Object: exec() یک SqlStorageCursor برمی‌گرداند
//      که مستقیماً iterable است و خاصیت .rows ندارد؛ سطر پیش‌فرض cursor آبجکت
//      است (کلید = نام ستون) و خواندن موقعیتی (سطر = آرایه) فقط از raw() است.
//      ضمناً BEGIN/COMMIT/ROLLBACK از طریق exec() در runtime واقعی Cloudflare
//      ممنوع است و خطا می‌دهد — نوشتن‌های متوالی بدون await اتمیک‌اند. این
//      ناسازگاری فقط در اجرای واقعی Cloudflare آشکار شد.
// ─────────────────────────────────────────────────────────────────────────────

// ---- توابع کمکی ----

function id(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "k_" + (hash >>> 0).toString(16);
}

function parse(val) {
  return String(val || "").split(",").map(s => s.trim()).filter(Boolean);
}

function find(val, kid) {
  return parse(val).find(k => id(k) === kid) || "";
}

function validId(v) {
  return !!v && /^[A-Za-z0-9._:=+@-]{1,128}$/.test(v);
}

function getRetryAfter(resp) {
  const val = resp.headers.get("retry-after");
  if (!val) return null;
  const num = Number(val);
  if (Number.isFinite(num)) return Math.max(0, num * 1000);
  const date = Date.parse(val);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function calculateWait(resp, attempt, backoff, maxBackoff) {
  const retryAfterMs = getRetryAfter(resp);
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(maxBackoff, retryAfterMs);
  }
  return Math.min(maxBackoff, backoff * 2 ** attempt + Math.random() * 250);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(level, message, ...args) {
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  console[level === "error" ? "error" : "log"](prefix, message, ...args);
}

// ---- Durable Object ----

export class ApiKeyCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
        failures INTEGER NOT NULL DEFAULT 0,
        latency REAL NOT NULL DEFAULT 500,
        state TEXT NOT NULL DEFAULT 'healthy',
        cooldown INTEGER NOT NULL DEFAULT 0,
        inflight INTEGER NOT NULL DEFAULT 0,
        last_used INTEGER NOT NULL DEFAULT 0,
        last_success INTEGER NOT NULL DEFAULT 0,
        last_failure INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  async fetch(req) {
    const action = new URL(req.url).pathname.slice(1);
    if (action === "select") return this.select(await req.json().catch(() => ({})));
    if (action === "release") return this.release(await req.json());
    if (action === "cancel") return this.cancel(await req.json());
    if (action === "stats") return this.stats();
    return Response.json({ error: "unknown_coordinator_action" }, { status: 404 });
  }

  // کلیدهای جدید را اضافه و حذف‌شده‌ها را پاک می‌کند
  async sync() {
    const keys = parse(this.env.UPSTREAM_API_KEYS);
    const allowed = new Set(keys.map(id));
    for (const k of keys) {
      this.sql.exec("INSERT OR IGNORE INTO keys(id) VALUES(?)", id(k));
    }
    // cursor پیش از هر DELETE کاملاً مصرف می‌شود (حذف سطر حین پیمایش cursor ایمن نیست)
    const existing = [...this.sql.exec("SELECT id FROM keys").raw()].map(r => r[0]);
    for (const kid of existing) {
      if (!allowed.has(kid)) {
        this.sql.exec("DELETE FROM keys WHERE id=?", kid);
      }
    }
    return keys;
  }

  /**
   * انتخاب کلید (دو مرحله‌ای):
   *  ۱) کلید سالمِ «متفاوت» از excludeها (failover واقعی)
   *  ۲) اگر allow_degraded و هیچ کلید دیگری نبود: کلید degraded (حتی با
   *     cooldown فعال) — برای retryهای 5xx/خطای شبکه با همان کلید.
   *  زمان‌بندی فقط با cooldown کنترل می‌شود؛ کلید invalid (401) پس از پایان
   *  AUTH_COOLDOWN_MS خودبه‌خود برای درخواست‌های جدید بازیابی می‌شود
   *  (مسدودی دائمی وجود ندارد) و rate_limited پس از پایان cooldown آن.
   */
  async select(data = {}) {
    await this.sync();
    const now = Date.now();
    const exclude = Array.isArray(data.exclude) ? data.exclude : [];
    const allowDegraded = data.allow_degraded ? 1 : 0;

    const ph = exclude.map(() => "?").join(",");
    const excludedSql = exclude.length ? `AND id NOT IN (${ph})` : "";

    // مرحله ۱: کلید متفاوت و سالم
    let rows = [...this.sql.exec(`
      SELECT id FROM keys
      WHERE (cooldown = 0 OR cooldown <= ?)
        ${excludedSql}
      ORDER BY (total + inflight * 200) ASC,
                failures ASC,
                latency ASC,
                last_used ASC
      LIMIT 1
    `, now, ...exclude).raw()];

    // مرحله ۲: retry با کلید degraded همین درخواست (5xx/خطای شبکه)
    if (!rows.length && allowDegraded) {
      rows = [...this.sql.exec(`
        SELECT id FROM keys
        WHERE state = 'degraded'
        ORDER BY (total + inflight * 200) ASC,
                  failures ASC,
                  latency ASC,
                  last_used ASC
        LIMIT 1
      `).raw()];
    }

    if (!rows.length) {
      log("warn", "No healthy API key available");
      return Response.json({ error: "no_healthy_api_key" }, { status: 503 });
    }
    const kid = rows[0][0];
    this.sql.exec(`
      UPDATE keys
      SET inflight = inflight + 1,
          requests = requests + 1,
          last_used = ?
      WHERE id = ?
    `, now, kid);
    const apiKey = find(this.env.UPSTREAM_API_KEYS, kid);
    return Response.json({ key_id: kid, api_key: apiKey });
  }

  async release(data) {
    const kid = String(data.key_id || "");
    const row = [...this.sql.exec("SELECT latency, failures FROM keys WHERE id=?", kid).raw()][0];
    if (!row) return Response.json({ error: "unknown_key_id" }, { status: 404 });

    const now = Date.now();
    const status = Number(data.status || 0);
    const latency = Math.max(1, Number(data.latency_ms || 1));
    const input = Math.max(0, Number(data.input_tokens || 0));
    const output = Math.max(0, Number(data.output_tokens || 0));
    const total = Math.max(0, Number(data.total_tokens || input + output));

    const cfg = {
      rateCooldown: Number(this.env.RATE_COOLDOWN_MS) || 30000,
      authCooldown: Number(this.env.AUTH_COOLDOWN_MS) || 900000,
      transientCooldown: Number(this.env.TRANSIENT_COOLDOWN_MS) || 5000,
      maxBackoff: Number(this.env.MAX_BACKOFF_MS) || 60000,
    };

    let state = "healthy";
    let cooldown = 0;
    let incFailures = 0;
    const isSuccess = status >= 200 && status < 300;
    const isRedirect = status >= 300 && status < 400;
    const isClientError = status >= 400 && status < 500;
    // 3xx (مثلاً 304 با هدرهای شرطی، یا انتهای زنجیره‌ی redirect) پاسخ قابل‌قبول است؛
    // شاخه‌ی redirect کلید را healthy اعلام می‌کند، پس حسابداری هم باید همین را بگوید.
    const isOk = isSuccess || isRedirect;

    if (status === 401) {
      // کلید مشکوک به تعویض: قرنطینه‌ی موقت (نه مسدودی دائمی)
      state = "invalid";
      cooldown = now + cfg.authCooldown;
      incFailures = 1;
    } else if (status === 403) {
      state = "degraded";
      cooldown = now + cfg.authCooldown;
      incFailures = 1;
    } else if (status === 429) {
      state = "rate_limited";
      let retryAfterMs = Number(data.retry_after_ms || 0);
      if (!retryAfterMs || retryAfterMs < cfg.rateCooldown) retryAfterMs = cfg.rateCooldown;
      cooldown = now + Math.min(cfg.maxBackoff, retryAfterMs);
      incFailures = 1;
    } else if (status === 0 || (status >= 500 && status < 600) || [408, 425].includes(status)) {
      state = "degraded";
      cooldown = now + cfg.transientCooldown;
      incFailures = 1;
    } else if (isRedirect) {
      state = "healthy";
      incFailures = 0;
    } else if (isClientError) {
      // 400/404/422 و…: تقصیر کلید نیست؛ آمار خطا ثبت ولی جریمه نمی‌شود
      state = "healthy";
      incFailures = 0;
    } else if (!isSuccess) {
      state = "degraded";
      cooldown = now + cfg.transientCooldown;
      incFailures = 1;
    }

    // incFailures در هر شاخه‌ی بالا دقیقاً تعیین شده و منبع یگانه‌ی حقیقت است؛
    // بازمحاسبه‌ی آن با شرط عمومی (مثل isClientError یا status=0) باگ بود:
    // 401/403/429 جزو 4xx و خطای شبکه status=0 است و شمارش failures را دور می‌زد.
    const failures = Number(row[1]) + incFailures;
    const ema = Number(row[0]) * 0.8 + latency * 0.2;

    // UPDATE تک‌statement است و چون تا پایانش هیچ await نیست، در DO اتمیک است؛
    // ضمناً BEGIN/COMMIT از طریق sql.exec() در runtime واقعی Cloudflare ممنوع است.
    this.sql.exec(`
        UPDATE keys SET
          inflight = CASE WHEN inflight > 0 THEN inflight - 1 ELSE 0 END,
          total = total + ?,
          input = input + ?,
          output = output + ?,
          success = success + ?,
          errors = errors + ?,
          rate429 = rate429 + ?,
          failures = ?,
          latency = ?,
          state = ?,
          cooldown = ?,
          last_success = CASE WHEN ? THEN ? ELSE last_success END,
          last_failure = CASE WHEN ? THEN ? ELSE last_failure END
        WHERE id = ?
      `,
        total,
        input,
        output,
        isOk ? 1 : 0,
        isOk ? 0 : 1,
        status === 429 ? 1 : 0,
        failures,
        ema,
        state,
        cooldown,
        isOk ? 1 : 0,
        now,
        !isOk ? 1 : 0,
        now,
        kid
    );

    log("info", `Released key ${kid}, status ${status}, total ${total}`);
    return Response.json({ ok: true });
  }

  // رزروی که مصرف نشد (مثلاً کلید تکراری انتخاب شد) — فقط inflight آزاد می‌شود
  async cancel(data) {
    const kid = String(data.key_id || "");
    this.sql.exec(`
      UPDATE keys
      SET inflight = CASE WHEN inflight > 0 THEN inflight - 1 ELSE 0 END
      WHERE id = ?
    `, kid);
    return Response.json({ ok: true });
  }

  async stats() {
    await this.sync();
    const rows = [...this.sql.exec(`
      SELECT id, total, input, output, requests, success, errors, rate429,
             failures, latency, state, cooldown, inflight,
             last_used, last_success, last_failure
      FROM keys ORDER BY total ASC
    `).raw()];
    return Response.json({ keys: rows });
  }
}

// ---- توابع کمکی Worker ----

async function upstream(req, url, key, reqId, attempt, timeout, bodyBuffer, authMode) {
  const headers = new Headers(req.headers);
  const removeHeaders = [
    "authorization",
    "x-api-key",
    "x-auth-token",
    "x-router-api-key",
    "x-omniroute-provider",
    "host",
    "content-length",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-real-ip"
  ];
  for (const h of removeHeaders) headers.delete(h);

  // حالت احراز هویت upstream: Bearer (پیش‌فرض) یا x-api-key
  if (authMode === "x-api-key") {
    headers.set("x-api-key", key);
  } else {
    headers.set("authorization", `Bearer ${key}`);
  }
  headers.set("x-request-id", reqId);
  headers.set("x-provider-attempt", String(attempt));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(new Request(url, {
      method: req.method,
      headers: headers,
      // بدنه‌ی بافرشده در هر تلاش از کپی تازه ساخته می‌شود
      body: bodyBuffer ? bodyBuffer.slice(0) : undefined,
      redirect: "follow",
    }), { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function extractUsage(resp) {
  try {
    const data = await resp.clone().json();
    const u = data?.usage || data?.token_usage || {};
    const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
    const output = Number(u.output_tokens ?? u.completion_tokens ?? 0);
    const total = Number(u.total_tokens ?? data?.total_tokens ?? input + output);
    return {
      input_tokens: Number.isFinite(input) ? Math.max(0, input) : 0,
      output_tokens: Number.isFinite(output) ? Math.max(0, output) : 0,
      total_tokens: Number.isFinite(total) ? Math.max(0, total) : 0,
    };
  } catch {
    const total = Number(resp.headers.get("x-token-usage") || 0);
    return {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: Number.isFinite(total) ? Math.max(0, total) : 0,
    };
  }
}

function streamResponse(resp, coord, keyId, start, reqId, waitUntil) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  let released = false;
  const retryAfter = getRetryAfter(resp);

  const release = () => {
    if (released) return Promise.resolve();
    released = true;
    return releaseKey(coord, {
      key_id: keyId,
      status: resp.status,
      latency_ms: Date.now() - start,
      ...(usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
      retry_after_ms: retryAfter,
    }).catch(e => log("error", "Release failed in stream:", e?.message || e));
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const json = JSON.parse(line.slice(6));
            if (json?.usage) {
              usage = {
                input_tokens: json.usage.prompt_tokens || json.usage.input_tokens || 0,
                output_tokens: json.usage.completion_tokens || json.usage.output_tokens || 0,
                total_tokens: json.usage.total_tokens || 0,
              };
            }
          } catch {}
        }
      }
    },
    async flush() {
      // اتمام طبیعی استریم upstream → آزادسازی رزرو با usage ثبت‌شده
      await release();
    },
  });

  // تک‌لوله‌ای: resp.body فقط یک‌بار خوانده می‌شود؛ readable سمت transform
  // به کلاینت داده می‌شود. قطع اتصال کلاینت → cancel شدن readable →
  // خطای pump → catch → آزادسازی رزرو. بدون این، inflight لو می‌رود.
  const pump = resp.body.pipeTo(transform.writable).catch(() => release());
  waitUntil(pump);

  const headers = new Headers(resp.headers);
  headers.set("x-request-id", reqId);
  headers.set("cache-control", "no-store");

  return new Response(transform.readable, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

async function releaseKey(coord, data) {
  return coord.fetch("https://coordinator/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function cancelKey(coord, keyId) {
  return coord.fetch("https://coordinator/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key_id: keyId }),
  });
}

function isRetryable(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status) ||
         status === 401 || status === 403;
}

function finalizeResponse(resp, reqId) {
  const headers = new Headers(resp.headers);
  headers.set("x-request-id", reqId);
  headers.set("cache-control", "no-store");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function err(msg, status, extra = {}) {
  return Response.json({ error: msg }, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extra,
    },
  });
}

// ---- Factory Function ----

export function createFetchHandler(customConfig = {}) {
  return async function(request, env, ctx) {
    if (!env.UPSTREAM_BASE_URL || !env.UPSTREAM_API_KEYS) {
      return err("provider_not_configured", 500);
    }

    const config = {
      timeout: Number(env.UPSTREAM_TIMEOUT_MS) || Number(customConfig.timeout) || 180000,
      maxAttempts: Number(env.MAX_ATTEMPTS) || Number(customConfig.maxAttempts) || 4,
      backoff: Number(env.BACKOFF_MS) || Number(customConfig.backoff) || 350,
      maxBackoff: Number(env.MAX_BACKOFF_MS) || Number(customConfig.maxBackoff) || 60000,
      maxBodyBytes: Number(env.MAX_BODY_BYTES) || Number(customConfig.maxBodyBytes) || 25 * 1024 * 1024,
    };
    const authMode = String(env.AUTH_MODE || customConfig.authMode || "bearer").toLowerCase();
    const waitUntil = (p) => {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
      else if (p && typeof p.catch === "function") p.catch(() => {});
    };

    const url = new URL(request.url);
    const base = String(env.UPSTREAM_BASE_URL).replace(/\/+$/, "");
    const reqId = validId(request.headers.get("x-request-id"))
      ? request.headers.get("x-request-id")
      : crypto.randomUUID();
    const coord = env.KEY_COORDINATOR.getByName("global");

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > config.maxBodyBytes) {
      return err("request_body_too_large", 413, { "x-request-id": reqId });
    }

    // ── بدنه یک‌بار و قبل از حلقه‌ی failover بافر می‌شود ──
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
    const bodyBuffer = hasBody ? await request.arrayBuffer() : null;
    if (bodyBuffer && bodyBuffer.byteLength > config.maxBodyBytes) {
      return err("request_body_too_large", 413, { "x-request-id": reqId });
    }

    const tried = new Set();
    let lastResponse = null;
    let lastError = null;

    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
      // در تلاش‌های بعدی: کلیدهای امتحان‌شده حذف می‌شوند؛ کلید degradedِ
      // همین درخواست (5xx/خطای شبکه) مجاز به retry است.
      const selectReq = new Request("https://coordinator/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          exclude: [...tried],
          allow_degraded: attempt > 0,
        }),
      });
      const selectResp = await coord.fetch(selectReq);
      if (!selectResp.ok) {
        log("error", "Select failed:", selectResp.status);
        // اگر پاسخ واقعی upstream داریم، همان به کلاینت برسد
        if (lastResponse) return finalizeResponse(lastResponse, reqId);
        return err("no_healthy_api_key", 503, { "x-request-id": reqId });
      }
      const selectData = await selectResp.json();
      if (!selectData.api_key) {
        return err("no_additional_api_key_available", 503, { "x-request-id": reqId });
      }
      if (tried.has(selectData.key_id)) {
        // انتخاب تکراری یعنی کلید دیگری موجود نیست. تفکیک دو حالت:
        //  - اگر خطای قطعی کلید (401/403/429) داشتیم: رزرو بی‌استفاده آزاد و
        //    پایان کار با همان پاسخ واقعی upstream (retry بی‌معناست).
        //  - اگر خطای گذرا (5xx/شبکه) داشتیم: همین رزرو تازه برای تلاش
        //    مجدد با همان کلید استفاده می‌شود (لغو نکن!).
        const decisive = lastResponse && [401, 403, 429].includes(lastResponse.status);
        if (decisive) {
          await cancelKey(coord, selectData.key_id).catch(() => {});
          log("warn", "No additional key available — returning last upstream response");
          return finalizeResponse(lastResponse, reqId);
        }
        log("warn", "No additional key available — retrying with same key");
      }
      tried.add(selectData.key_id);

      const start = Date.now();
      try {
        const upstreamResp = await upstream(
          request,
          `${base}${url.pathname}${url.search}`,
          selectData.api_key,
          reqId,
          attempt,
          config.timeout,
          bodyBuffer,
          authMode
        );

        const contentType = upstreamResp.headers.get("content-type") || "";
        if (contentType.toLowerCase().includes("text/event-stream")) {
          return streamResponse(upstreamResp, coord, selectData.key_id, start, reqId, waitUntil);
        }

        const usage = await extractUsage(upstreamResp);
        await releaseKey(coord, {
          key_id: selectData.key_id,
          status: upstreamResp.status,
          latency_ms: Date.now() - start,
          ...usage,
          retry_after_ms: getRetryAfter(upstreamResp),
        });

        lastResponse = upstreamResp;

        if (upstreamResp.ok || (upstreamResp.status >= 300 && upstreamResp.status < 400)) {
          return finalizeResponse(upstreamResp, reqId);
        }

        if (isRetryable(upstreamResp.status) && attempt + 1 < config.maxAttempts) {
          const waitMs = calculateWait(upstreamResp, attempt, config.backoff, config.maxBackoff);
          log("info", `Retry attempt ${attempt+1} after ${waitMs}ms for status ${upstreamResp.status}`);
          await sleep(waitMs);
          continue;
        }

        return finalizeResponse(upstreamResp, reqId);
      } catch (e) {
        lastError = e;
        log("error", `Request error (attempt ${attempt}):`, e?.message || e);
        await releaseKey(coord, {
          key_id: selectData.key_id,
          status: 0,
          latency_ms: Date.now() - start,
        }).catch(() => {});
        if (attempt + 1 < config.maxAttempts) {
          const waitMs = Math.min(config.maxBackoff, config.backoff * 2 ** attempt + Math.random() * 250);
          await sleep(waitMs);
          continue;
        }
      }
    }

    if (lastResponse) return finalizeResponse(lastResponse, reqId);
    const errorMsg = lastError?.name === "AbortError" ? "upstream_timeout" : "upstream_unavailable";
    return err(errorMsg, 502, { "x-request-id": reqId });
  };
}
