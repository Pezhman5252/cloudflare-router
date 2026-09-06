# PolyRoute v5

روتر Cloudflare Workers برای Providerهای سازگار با OpenAI، با Service Binding، Durable Object و SQLite.

> **Release status:** Release Candidate. قبل از انتشار عمومی، تست واقعی Cloudflare staging و `npm run check` باید سبز باشند.

## معماری

```text
Client
  │
  ▼
Master Router
  │  auth / route / request-id
  ▼
Service Binding
  │
  ▼
Provider Worker
  │
  ├── bounded retry / failover
  ├── SSE streaming + usage extraction
  └── Durable Object
        └── SQLite
             ├── key state
             ├── daily/monthly/lifetime usage
             ├── health / latency
             ├── cooldown / Retry-After
             ├── circuit breaker
             └── inflight reservations
  │
  ▼
Upstream API
```

## Routing و reliability

نسخه V5 این سیاست‌ها را پیاده می‌کند:

- انتخاب کلید بر اساس مصرف روزانه/ماهانه، lifetime usage، inflight، latency و failure history.
- quota-aware routing با `DAILY_TOKEN_LIMIT` و `MONTHLY_TOKEN_LIMIT`.
- `unknown usage` هرگز به‌عنوان مصرف صفرِ شناخته‌شده ثبت نمی‌شود.
- شناسه‌ی کلیدها SHA-256 است؛ خود secret هیچ‌وقت در state ذخیره نمی‌شود.
- 401/403/429 کلید را quarantine می‌کنند و روی کلید دیگری failover می‌شود.
- `Retry-After` به‌صورت ثانیه یا HTTP-date خوانده و روی همان key اعمال می‌شود؛ request برای امتحان کردن key دیگر بی‌دلیل نمی‌خوابد.
- خطاهای 408/425/5xx و network/timeout به‌صورت transient مدیریت می‌شوند.
- circuit breaker شامل `healthy → degraded → open → half_open → healthy` است.
- برای HALF_OPEN فقط یک probe هم‌زمان مجاز است.
- retry دارای سقف attempt، backoff و total retry time است.
- Master Router عمداً retry نمی‌کند تا retry ضربدری ایجاد نشود.
- POST/PUT/PATCH قبل از failover یک‌بار buffer می‌شوند (تا سقف `MAX_BODY_BYTES`) و هر attempt همان body یکسان را replay می‌کند.
- اگر فرآیند Worker بین انتخاب کلید و release از بین برود، lease `reserved_at` در next انتخاب، رزروasion و probe یتیم را پس از انقضای lease آزاد می‌کند (پوشش test 14b).
- فقط SSE موفق وارد streaming می‌شود؛ SSE با status خطا وارد failover عادی می‌شود.
- SSE usage حتی وقتی JSON در چند chunk تقسیم شده باشد استخراج می‌شود.
- `inflight` در release/cancel آزاد می‌شود و در خطاهای داخلی نیز مسیر cleanup دارد.

## نصب

نیازمند Node.js 22+ است.

```bash
npm ci
```

سپس:

```bash
npx wrangler login
```

Secretها:

```bash
npx wrangler secret put ROUTER_API_KEY -c router/wrangler.toml
npx wrangler secret put UPSTREAM_API_KEYS -c providers/bai/wrangler.toml
npx wrangler secret put UPSTREAM_API_KEYS -c providers/dahl/wrangler.toml
```

## تست

تست مستقل Node + SQLite:

```bash
npm test
```

تست syntax و configuration:

```bash
npm run test:all
```

اعتبارسنجی واقعی Wrangler:

```bash
npm run check
```

Cloudflare برای تست Durable Objects استفاده از Workers Vitest integration را توصیه می‌کند؛ این repository علاوه بر suite محلی، `npm run check` را نیز به‌عنوان gate انتشار نگه می‌دارد. urlCloudflare Durable Objects testing documentationhttps://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/

## Configuration مهم

Providerها:

| متغیر | پیش‌فرض | توضیح |
|---|---:|---|
| `MAX_ATTEMPTS` | `4` | حداکثر attempt برای هر request |
| `MAX_RETRY_TIME_MS` | `15000` | سقف زمانی retry |
| `MAX_BACKOFF_MS` | `60000` | سقف backoff تصادفی |
| `MAX_COOLDOWN_MS` | `900000` | سقف quarantine/cooldown |
| `UPSTREAM_TIMEOUT_MS` | `25000` | timeout هر upstream attempt |
| `MAX_BODY_BYTES` | `10485760` | سقف body ورودی |
| `DAILY_TOKEN_LIMIT` | `0` | صفر یعنی بدون سقف |
| `MONTHLY_TOKEN_LIMIT` | `0` | صفر یعنی بدون سقف |
| `AUTH_COOLDOWN_MS` | `900000` | quarantine بعد از 401 |
| `FORBIDDEN_COOLDOWN_MS` | `900000` | quarantine بعد از 403 |
| `RATE_COOLDOWN_MS` | `30000` | حداقل cooldown برای 429 |
| `TRANSIENT_COOLDOWN_MS` | `5000` | cooldown خطای transient |

## انتشار

قبل از Public Release باید این‌ها سبز باشند:

```bash
npm ci
npm run test:all
npm run check
```

سپس ابتدا staging واقعی Cloudflare را تست کنید و بعد:

```bash
npm run deploy
```

جزئیات gate انتشار در `RELEASE_CHECKLIST.md` است.


## API key configuration (V5.0.6)

`UPSTREAM_API_KEYS` accepts the legacy comma-separated format, semicolon/newline-separated values, or a JSON array. Use the JSON-array form when a provider key itself can contain commas, for example `[`"`key,with,commas`"`]`. The provider worker enforces the configured body limit incrementally and buffers only up to that limit because request replay is required for failover retries.


### Request body handling (V5.0.6)

The router performs an early `Content-Length` rejection but does not buffer request bodies. Chunked/streamed bodies are forwarded directly through the Service Binding. The provider is the authoritative bounded replay boundary: it incrementally reads and buffers only up to `MAX_BODY_BYTES`, returning HTTP 413 when the limit is exceeded. This avoids buffering the same request body twice while preserving retry/failover replay.

### V5.0.6 hardening notes

- Stuck-reservation lease GC: a worker that dies between key selection and release can no longer pin a key (or an orphaned half-open probe) forever; reservations older than `max(UPSTREAM_TIMEOUT_MS + MAX_RETRY_TIME_MS + 60s, MAX_COOLDOWN_MS)` are reclaimed on the next selection.
- Hop-by-hop headers are stripped at both the router and the provider; conditional-request (`if-none-match`, …), `Range` and `Expect` are stripped upstream so a cached 304 or clipped body can never corrupt usage accounting or retries. Upstream `Set-Cookie` never reaches clients.
- `parseKeys` also accepts human-written bracket forms (`['a','b']`, `[key1, key2]`) instead of silently mangling them into wrong key IDs.
- The router and provider parse `MAX_BODY_BYTES` identically (non-positive/non-numeric falls back to the default).
- SSE passthrough bounds its line-remainder buffer so a hostile upstream cannot grow worker memory without limit.
- `503 no_healthy_api_key` responses are self-explanatory: they carry a `reason` (`no_api_keys_configured` vs `all_keys_in_cooldown_or_quota`), `retry_after_ms` and a standard `Retry-After` header, and every key release logs `Key released … status=… state=… cooldown_ms=…` so cooldown/quarantine causes are visible in `wrangler tail`.
- Long SSE silences (reasoning models "thinking") can no longer let idle hops kill the stream: the provider emits `: keep-alive` SSE comments after `SSE_HEARTBEAT_MS` of upstream silence (default 15s, `0` disables). Streams that break mid-flight or end without a terminator are closed cleanly with a structured `upstream_stream_truncated` SSE error event followed by `[DONE]` — the client always receives a complete, parseable stream, and every such event is logged (`Upstream stream broke without finish signal`) for tail diagnosis.
- Content negotiation is pinned to encodings the runtime can always decode (`accept-encoding` is stripped before the upstream fetch), and any content-encoded response body still passing through is never given byte-level injections (no heartbeat, no trailer) — an encoded stream can never be corrupted by the proxy.
