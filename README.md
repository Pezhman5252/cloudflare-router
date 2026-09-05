# Cloudflare Router v4 (فیکس‌شده)

Router روی Cloudflare Workers برای Providerهای سازگار با OpenAI، با هماهنگی کلید روی Durable Object و SQLite.

## وضعیت این نسخه

این پروژه از نسخه‌ی قبلی با رفع باگ‌های بحرانی زیر به دست آمده است (همه با تست اجرایی اثبات شده‌اند):

| # | مشکل قبلی | رفع اعمال‌شده |
|---|-----------|---------------|
| ۱ | هر درخواست استریم SSE با `Invalid state: The ReadableStream is locked` شکست می‌خورد و همه‌ی کلیدها خرج می‌شدند (double-pipe روی `resp.body`) | استریم اکنون **تک‌لوله‌ای** است: `upstream → TransformStream` یک‌بار pipe می‌شود و `readable` به کلاینت داده می‌شود؛ usage از رویدادهای `data:` حین عبور استخراج و در پایان استریم ثبت می‌شود |
| ۲ | failover روی POST کاملاً مرده بود (`request.body` فقط یک‌بار قابل خواندن است) | بدنه یک‌بار و **قبل از حلقه** با `arrayBuffer()` بافر می‌شود و هر تلاش از کپی تازه استفاده می‌کند |
| ۳ | راوتر با `workers_dev=false` و بدون هیچ route عملاً غیرقابل دسترس بود | `workers_dev=true` در `router/wrangler.toml` (کلید گیت‌وی دسترسی را کنترل می‌کند) |
| ۴ | کلیدی که 401 می‌گرفت برای همیشه `invalid` می‌شد (کلید اشتباه وارد شده یا تعویض موقت، ظرفیت را برای همیشه می‌بست) | 401 فقط یک **قرنطینه‌ی موقت** (`AUTH_COOLDOWN_MS`، پیش‌فرض ۱۵ دقیقه) است؛ پس از آن کلید خودبه‌خود برای درخواست‌های جدید بازیابی می‌شود |
| ۵ | `redirect:"manual"` هدر `Location` و بدنه‌ی redirect را به کلاینت لو می‌داد | `redirect:"follow"` — کلیدها بدون افشای مقصد دنبال می‌شوند |
| ۶ | هدر `authorization` همیشه Bearer بود (کلیدهای x-api-key مثل برخی Providerها کار نمی‌کردند) | متغیر `AUTH_MODE` (`bearer` پیش‌فرض / `x-api-key`) در wrangler.toml هر provider |
| ۷ | کلید تکراری در حلقه → خطای مبهم و لو رفتن inflight | تشخیص «کلید دیگری نیست»: خطای **قطعی** (401/403/429) → پاس واقعی upstream به کلاینت؛ خطای **گذرا** (5xx/شبکه) → retry مشروع با همان کلید |
| ۸ | 400/404 و خطاهای client دیگر کلید را جریمه می‌کردند | خطاهای client (`4xx` غیر از 401/403/408/425/429) passthrough فوری و بدون جریمه‌ی کلید هستند |
| ۹ | در اجرای واقعی Cloudflare، اولین درخواست با `this.sql.exec.rows is not iterable` شکست می‌خورد — shim تست، API واقعی SQL را درست شبیه‌سازی نکرده بود (cursor واقعی `.rows` ندارد، سطر پیش‌فرض آن آبجکت است و `BEGIN/COMMIT` از طریق `exec()` ممنوع است) | همه‌ی خواندن‌های موقعیتی به `cursor.raw()` (سطر = آرایه) منتقل شد؛ `BEGIN/COMMIT/ROLLBACK` حذف شد (نوشتن‌های متوالی بدون await خودکار اتمیک‌اند)؛ shim تست اکنون قرارداد واقعی `SqlStorageCursor` را شبیه‌سازی می‌کند |

## Architecture

```text
Client → Master Router → Service Binding → Provider Worker → Durable Object (SQLite) → Upstream API
```

هر provider یک Durable Object با SQLite برای هماهنگی با سازگاری قوی (strong consistency) دارد:

- رزرو اتمیک کلید و ردیابی in-flight
- حسابداری توکن total/input/output (JSON و SSE)
- انتخاب کم‌مصرف‌ترین کلید با توجه به همروندی (inflight × 200 در امتیاز)
- cooldown برای 429 با پشتیبانی از `Retry-After` (فرم ثانیه و HTTP-date)
- قرنطینه‌ی موقت 401 و 403 با بازیابی خودکار
- degradation گذرا برای 408/425/5xx/timeout/خطای شبکه (پیش‌فرض ۵ ثانیه)
- EMA تأخیر و شمارنده‌های سلامت
- failover محدود‌شده در سطح provider

Router اصلی **عمداً retry نمی‌کند** تا دو لایه‌ی retry، درخواست‌های قابل‌حساب AI را ضرب‌دری نکنند. فقط لایه‌ی provider failover دارد (`MAX_ATTEMPTS=4`).

## فایل‌ها

```text
cloudflare-router/
├── README.md
├── package.json
├── .gitignore
├── RELEASE_CHECKLIST.md
├── common/
│   └── provider-core.js        ← هسته‌ی مشترک: DO + حلقه‌ی failover
├── router/
│   ├── wrangler.toml
│   └── src/index.js
├── providers/
│   ├── bai/
│   │   ├── wrangler.toml
│   │   └── src/index.js
│   └── dahl/
│       ├── wrangler.toml
│       └── src/index.js
└── tests/
    └── v4-verify.mjs           ← ۴۵ تست با DO واقعی + SQLite واقعی
```

## نصب

```bash
npm install
npx wrangler login
```

تنظیم secrets:

```bash
npx wrangler secret put ROUTER_API_KEY -c router/wrangler.toml
npx wrangler secret put UPSTREAM_API_KEYS -c providers/bai/wrangler.toml
npx wrangler secret put UPSTREAM_API_KEYS -c providers/dahl/wrangler.toml
```

`UPSTREAM_API_KEYS` لیست جدا‌شده با کاما است:

```text
key1,key2,key3
```

هرگز secrets را commit نکنید.

## Deploy

اول providerها، بعد راوتر:

```bash
npm run deploy:providers
npm run deploy:router
```

یا:

```bash
npm run deploy
```

## مسیرها

```text
/a/... → https://api.b.ai/v1/...
/b/... → https://inference.dahl.global/v1/...
```

نمونه:

```text
https://omniroute-master-proxy.<subdomain>.workers.dev/a/chat/completions
https://omniroute-master-proxy.<subdomain>.workers.dev/b/chat/completions
```

## ویژگی‌های امنیتی

- کلیدهای Provider فقط Worker Secret می‌مانند.
- Durable Object فقط ID هش‌شده‌ی کلیدها را ذخیره می‌کند (هرگز خودِ کلید را).
- Providerها از طریق `workers_dev` و `preview_urls` عمومی نیستند.
- اعتبارنامه‌ی راوتر قبل از فوروارد حذف می‌شود.
- هدرهای شناساگر شبکه‌ی کلاینت حذف می‌شوند.
- پاسخ‌ها `no-store` هستند.
- محدودیت اندازه‌ی بدنه: ۲۵ MiB پیش‌فرض (`MAX_BODY_BYTES`).
- برای انتشار عمومی، WAF/rate limiting کلودفلر را جلوی راوتر فعال کنید.

## چرخه‌ی عمر کلید

| وضعیت | محرک | cooldown پیش‌فرض | بازیابی |
|--------|------|------------------|----------|
| `healthy` | 2xx/3xx/خطای client | — | — |
| `rate_limited` | 429 | ۳۰ ثانیه یا `Retry-After` (سقف ۶۰ ثانیه) | خودکار پس از cooldown |
| `invalid` | 401 | ۱۵ دقیقه | خودکار پس از cooldown (مسدودی دائمی وجود ندارد) |
| `degraded` | 403، 408/425/5xx، timeout، خطای شبکه | ۵ ثانیه (403: ۱۵ دقیقه) | خودکار پس از cooldown |

رفتار حلقه‌ی failover در هر درخواست:

- تلاش ۱: بهترین کلید سالم
- 401/403/429 → کلید بعدی (کلید فعلی exclude می‌شود)
- 5xx/timeout/خطای شبکه → اول کلید سالم دیگر؛ اگر نبود، retry با همان کلید (چون مقصر کلید نیست)
- خطای client (400/404/…) → passthrough فوری، بدون جریمه و بدون retry
- اتمام تلاش‌ها → آخرین پاس واقعی upstream (یا `502 upstream_unavailable` فقط برای خطای شبکه)

## Streaming

SSE با تک‌لوله‌ای کردن (`pipeTo` یک‌بار) پاس داده می‌شود؛ فیلدهای usage در رویدادهای `data:` حین عبور استخراج و پس از اتمام استریم ثبت می‌شوند. اگر upstream usage ندهد، صفر ثبت می‌شود نه مقدار جعلی. قطع اتصال کلاینت رزرو را آزاد می‌کند (inflight لو نمی‌رود).

## اعتبارسنجی اجرایی (اثبات)

```bash
node tests/v4-verify.mjs
```

۴۵ تست روی **کد واقعی** `provider-core.js` با **SQLite واقعی** (node:sqlite) و شبیه‌سازی دقیق قرارداد واقعی `SqlStorageCursor` مربوط به Durable Object (cursor مستقیم‌یتِرریت، سطر پیش‌فرض آبجکت، `raw()` برای سطر آرایه‌ای، و ممنوعیت BEGIN/COMMIT مثل runtime واقعی) اجرا می‌شود و پوشش می‌دهد: SSE سالم + استخراج usage، failover POST با 401، قرنطینه و بازیابی 401، failover 429، retry همان‌کلید روی 5xx، خطای شبکه ×۴، `AUTH_MODE=x-api-key`، اتمام کلیدها، passthrough 400، و رفتار راوتر (health/404/401/حذف کلید کلاینت).

برای بررسی باندل wrangler:

```bash
npm run check
```

## محدودیت‌های صادقانه

- این تست‌ها رفتار هسته را روی Node با شبیه‌سازی `cloudflare:workers` و قرارداد واقعی SQL اثبات می‌کنند؛ قرار دادن در staging واقعی (همان کد با wrangler dev یا deploy آزمایشی) قبل از تکیه‌ی کامل ضروری است — به‌خصوص قراردادهای دقیق احراز هویت و مدل‌های BAI/Dahl. (باگ شماره‌ی ۹ جدول بالا دقیقاً در اجرای واقعی کشف شد، نه در تست.)
- در Windows هنگام اجرای تست، هشدار آزمایشی بودن `node:sqlite` طبیعی است.
- اجرای Durable Object هزینه‌ی جزئی requests/duration دارد؛ با تعداد کلیدهای کم ناچیز است.
- اگر upstream در پاسخ JSON usage ندهد و هدر `x-token-usage` هم نداشته باشد، مصرف صفر ثبت می‌شود.
- تایم‌اوت با `AbortController` پیاده شده؛ در service binding های درون‌workerd پشتیبانی سیگنال ممکن است کامل نباشد (تایم‌اوت روی fetch مستقیم provider→upstream اعمال می‌شود).

## توصیه‌ی تولید

Wrangler را روی نسخه‌ی آزموده pin کنید، staging/production را جدا نگه دارید، کلیدها را دوره‌ای بچرخانید، WAF/rate limiting را فعال کنید و توزیع وضعیت/خطا/تأخیر upstream را پایش کنید.
