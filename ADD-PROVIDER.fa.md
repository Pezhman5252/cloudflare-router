# راهنمای افزودن یک Provider جدید — PolyRoute v5

این راهنما قدم‌به‌قدم توضیح می‌دهد که برای اضافه‌کردن یک Provider (سرویس upstream سازگار با OpenAI) به PolyRoute دقیقاً باید **کدام فایل‌ها را تغییر دهید**. مثال اجرایی این راهنما، اضافه‌کردن یک Provider فرضی به نام **`nova`** با پیشوند مسیر **`/c`** است؛ شما به‌جای `nova` نام پروایدر خودتان را بگذارید.

> **پیش‌نیاز:** Provider جدید باید API سازگار با OpenAI داشته باشد (یعنی `POST {base}/chat/completions` با بدنه‌ی `messages` و پاسخ JSON مشابه OpenAI و ترجیحاً پشتیبانی از `"stream": true`). تمام منطق retry/failover/circuit-breaker/کلید‌ها به‌صورت مشترک در `common/provider-core.js` پیاده‌سازی شده و یک Provider جدید **هیچ منطقی نمی‌نویسد** — فقط دو فایل کوچک می‌سازد و دو فایل را ویرایش می‌کند.

---

## نمای کلی — چه فایل‌هایی دست‌خوش تغییر می‌شوند؟

| # | فایل | نوع تغییر |
|---|------|-----------|
| ۱ | `providers/nova/wrangler.toml` | **ساخت** — تنظیمات Worker جدید |
| ۲ | `providers/nova/src/index.js` | **ساخت** — ۱۳ خط، بدون منطق |
| ۳ | `router/wrangler.toml` | **ویرایش** — افزودن یک بلوک `[[services]]` |
| ۴ | `router/src/index.js` | **ویرایش** — افزودن یک خط به `ROUTES` |
| ۵ | `package.json` | **ویرایش** — افزودن اسکریپت‌های `deploy:nova` و `dev:nova` |
| ۶ | `tests/static-verify.mjs` | **ویرایش** — افزودن مسیر TOML جدید به لیست بررسی |
| ۷ | Secret | **دستور** — `UPSTREAM_API_KEYS` برای Worker جدید |

> بقیه‌ی پروژه (هسته‌ی `common/provider-core.js`، تست‌های `tests/v5-verify.mjs`، مهاجرت Durable Object) **هیچ تغییری نمی‌خواهد** — چون هر Provider یک Worker مستقل با DO مستقل خودش است.

---

## مرحله ۱ — ساخت پوشه و دو فایل Provider

پوشه‌ی جدید بسازید: `providers/nova/` با زیرپوشه‌ی `src/`.

### ۱-۱) فایل `providers/nova/wrangler.toml`

```toml
name="polyroute-provider-nova"
main="src/index.js"
compatibility_date="2026-09-05"
workers_dev=false
preview_urls=false

[placement]
mode="smart"

[vars]
UPSTREAM_BASE_URL="https://api.nova.example.com/v1"
# نحوه‌ی ارسال کلید به upstream: "bearer" یا "x-api-key"
AUTH_MODE="bearer"
ENVIRONMENT="production"
MAX_BODY_BYTES="10485760"
UPSTREAM_TIMEOUT_MS="25000"
MAX_ATTEMPTS="4"
BACKOFF_MS="350"
MAX_BACKOFF_MS="60000"
MAX_RETRY_TIME_MS="15000"
MAX_COOLDOWN_MS="900000"
DAILY_TOKEN_LIMIT="0"
MONTHLY_TOKEN_LIMIT="0"
RATE_COOLDOWN_MS="30000"
AUTH_COOLDOWN_MS="900000"
TRANSIENT_COOLDOWN_MS="5000"

[[durable_objects.bindings]]
name="KEY_COORDINATOR"
class_name="ApiKeyCoordinator"

[[migrations]]
tag="v1"
new_sqlite_classes=["ApiKeyCoordinator"]

[secrets]
required=["UPSTREAM_API_KEYS"]
```

**مهم‌ترین نکته‌ی این فایل:** مقدار `name` باید **دقیقاً** با چیزی که در مرحله ۲ در `[[services]]` راوتر می‌نویسید یکی باشد (حساس به بزرگی/کوچکی حروف). این تنها قراردادِ اتصال بین راوتر و Provider است.

### ۱-۲) فایل `providers/nova/src/index.js`

```js
import { createFetchHandler, ApiKeyCoordinator } from "../../../common/provider-core.js";

export { ApiKeyCoordinator };

// تنظیمات خاص nova (در صورت نیاز)
const customConfig = {
  // timeout: 120000,
  // maxAttempts: 3,
};

export default {
  fetch: createFetchHandler(customConfig)
};
```

همین. تمام منطق (بافر کردن بدنه، انتخاب کلید، retry، استریم SSE، استخراج usage، قطع‌کننده‌ی مدار) از هسته‌ی مشترک می‌آید.

### معنی تنظیمات `wrangler.toml`

| تنظیم | معنی | نکته |
|---|---|---|
| `UPSTREAM_BASE_URL` | ریشه‌ی API پروایدر | اسلش انتهایی خودکار حذف می‌شود؛ مسیر کلاینت عیناً به آن چسبانده می‌شود: کلاینت `/c/chat/completions` → `https://…/v1/chat/completions` |
| `AUTH_MODE` | `bearer` = هدر `Authorization: Bearer <key>` ، `x-api-key` = هدر `x-api-key: <key>` | مطابق مستندات واقعی پروایدر خودتان تنظیم کنید |
| `MAX_BODY_BYTES` | سقف بدنه‌ی درخواست (بایت) | فراتر از آن پاسخ `413` — مقدار پیش‌فرض ۱۰ مگابایت |
| `UPSTREAM_TIMEOUT_MS` | تایم‌اوت هر تلاش upstream | ⚠️ تست استاتیک دقیقاً مقدار `"25000"` را چک می‌کند؛ اگر عوضش کردید، همان یک regex را در `tests/static-verify.mjs` هم به‌روز کنید |
| `MAX_ATTEMPTS` | حداکثر تعداد تلاش (شامل تلاش اول) | ۴ یعنی حداکثر ۳ فیلوور |
| `BACKOFF_MS` / `MAX_BACKOFF_MS` | پایه و سقف backoff نمایی با jitter | — |
| `MAX_RETRY_TIME_MS` | بودجه‌ی کل زمان retry | اگر از تایم‌اوت کمتر باشد، تلاشِ کند عملاً fail-fast می‌شود |
| `MAX_COOLDOWN_MS` | سقف سردشدن هر کلید | شامل سقف `Retry-After` |
| `DAILY_TOKEN_LIMIT` / `MONTHLY_TOKEN_LIMIT` | سهمیه توکن روزانه/ماهانه هر کلید | `0` = نامحدود (فقط شمارش) |
| `RATE_COOLDOWN_MS` | سردشدن کلید بعد از `429` | اگر upstream هدر `Retry-After` بدهد همان استفاده می‌شود |
| `AUTH_COOLDOWN_MS` | قرنطینه کلید بعد از `401` | — |
| `TRANSIENT_COOLDOWN_MS` | حداقل مکث قبل از تلاش مجدد روی خطاهای گذرا (۵xx/timeout/شبکه) | — |
| `tag="v1"` | تگ مهاجرت DO | **برای هر Worker مستقل است** — Worker جدید از `v1` شروع می‌کند؛ عدد بقیه‌ی پروایدرها ربطی به آن ندارد |

---

## مرحله ۲ — وصل کردن Provider به راوتر

### ۲-۱) فایل `router/wrangler.toml` — یک بلوک اضافه کنید

```toml
[[services]]
binding="NOVA_WORKER"
service="polyroute-provider-nova"
```

- `binding`: نام دلخواه اما یکتا؛ باید با مرحله ۲-۲ یکی باشد. قرارداد فعلی: `<NAME>_WORKER`.
- `service`: **دقیقاً** همان `name` در `providers/nova/wrangler.toml`.

### ۲-۲) فایل `router/src/index.js` — یک خط به `ROUTES` اضافه کنید

```js
const ROUTES = [
  { prefix: "/a", binding: "BAI_WORKER", provider: "bai" },
  { prefix: "/b", binding: "DAHL_WORKER", provider: "dahl" },
  { prefix: "/c", binding: "NOVA_WORKER", provider: "nova" },
].sort((a, b) => b.prefix.length - a.prefix.length);
```

- `prefix`: مسیر عمومی کلاینت‌ها. کلاینت `/c/...` می‌زند، راوتر همان `/...` را به nova می‌رساند.
- `binding`: همان نام binding مرحله ۲-۱ (به‌صورت `env[route.binding]` خوانده می‌شود).
- `provider`: برچسب کوتاه؛ در هدر پاسخ `x-polyroute-provider`، در پیام‌های خطا و لاگ‌ها ظاهر می‌شود.
- مرتب‌سازی خودکار است: اگر روزی پیشوندی داخل پیشوند دیگری بود (مثل `/c` و `/c-special`)، طولانی‌تر اول چک می‌شود — لازم نیست کاری کنید.

> ⚠️ **دقت کنید:** در همان فایل، بلوک `removeHeaders` هدر `x-polyroute-provider` را حذف نمی‌کند (این هدرِ داخلی راوتر است) و نیازی به تغییر CORS هم نیست — روش‌های احراز هویت عمومی قبلاً در `access-control-allow-headers` پوشش داده شده‌اند.

---

## مرحله ۳ — اسکریپت‌های npm (`package.json`)

سه اسکریپت اضافه و دو اسکریپت را گسترش دهید:

```json
"deploy:nova": "wrangler deploy -c providers/nova/wrangler.toml",
"dev:nova": "wrangler dev -c providers/nova/wrangler.toml",
```

و این دو را به‌روز کنید تا nova هم داخل زنجیره بیفتد:

```json
"deploy:providers": "npm run deploy:bai && npm run deploy:dahl && npm run deploy:nova",
"check": "wrangler deploy --dry-run -c providers/bai/wrangler.toml && wrangler deploy --dry-run -c providers/dahl/wrangler.toml && wrangler deploy --dry-run -c providers/nova/wrangler.toml && wrangler deploy --dry-run -c router/wrangler.toml"
```

---

## مرحله ۴ — تست استاتیک (`tests/static-verify.mjs`)

مسیر TOML جدید را به آرایه‌ی `configs` اضافه کنید تا همان ۷ بررسی خودکار رویش اجرا شود:

```js
const configs = [
  "providers/bai/wrangler.toml",
  "providers/dahl/wrangler.toml",
  "providers/nova/wrangler.toml",
  "router/wrangler.toml",
];
```

> بدون این خط، پروژه کار می‌کند اما پروایدر جدید از بررسی‌های خودکار جا می‌ماند — اضافه‌اش کنید.

---

## مرحله ۵ — Secret کلیدهای پروایدر جدید

```powershell
npx wrangler secret put UPSTREAM_API_KEYS -c providers/nova/wrangler.toml
```

فرمت مقدار، همان قواعد همه‌جای پروژه است: یک کلید، یا چند کلید در قالب آرایه‌ی JSON (`["k1","k2"]`)، یا جداشده با خط جدید / `;` / `,`. حالت‌های انسانی مثل `['k1','k2']` و `[k1, k2]` هم پارس می‌شوند.

---

## مرحله ۶ — تأیید محلی و دیپلوی

```powershell
node --check providers/nova/src/index.js   # خطای سینتکس نداشته باشد
npm run test:all                            # syntax + static + 53 تست
npm run check                               # باندل خشک هر ۴ ورکر (خارج از سندباکس)
npm run deploy:providers                    # ترتیب مهم است: اول همه‌ی providerها…
npm run deploy:router                       # …بعد راوتر (binding به نام providerها وصل است)
```

تست واقعی بعد از دیپلوی، دقیقاً مثل مرحله ۶ INSTALL.md است — فقط به‌جای `/a/...` از `/c/...` استفاده کنید و `x-polyroute-provider: nova` را در پاسخ چک کنید.

---

## اشتباهات رایج (این‌ها را چک کنید)

| اشتباه | علامت | راه‌حل |
|---|---|---|
| `service` در راوتر ≠ `name` در TOML پروایدر | `503 provider_binding_unavailable` | دو مقدار را کاراکتربه‌کاراکتر یکسان کنید |
| `binding` در `[[services]]` ≠ `binding` در `ROUTES` | `503 provider_binding_unavailable` | هر دو باید `NOVA_WORKER` باشند |
| `export { ApiKeyCoordinator }` در `src/index.js` جا افتاده | دیپلوی fail می‌شود (کلاس DO پیدا نمی‌شود) | خط export را طبق قالب برگردانید |
| جا انداختن `[[migrations]]` در TOML | خطای wrangler هنگام deploy | بلوک `v1` را عیناً کپی کنید |
| دادن `workers_dev=true` به پروایدر | **امنیتی** — پروایدر بدون گیت‌وری از اینترنت در دسترس می‌شود | همیشه `false` بماند؛ تنها ورودی عمومی، راوتر است |
| حذف یا تغییر `compatibility_date="2026-09-05"` | `STATIC RESULT: FAIL` | مقدار را نگه دارید |
| قرار دادن کلید در `[vars]` به‌جای secret | افشای کلید در تنظیمات | کلیدها فقط با `wrangler secret put` |

---

## چک‌لیست نهایی افزودن Provider

- [ ] `providers/<name>/wrangler.toml` ساخته شد (`name` یکتا، DO، مهاجرت `v1`، secret)
- [ ] `providers/<name>/src/index.js` ساخته شد (۱۳ خط قالب، export حفظ شده)
- [ ] `router/wrangler.toml` → بلوک `[[services]]` اضافه شد
- [ ] `router/src/index.js` → خط `ROUTES` اضافه شد
- [ ] `package.json` → `deploy:<name>` و `dev:<name>` و گسترش `deploy:providers` و `check`
- [ ] `tests/static-verify.mjs` → مسیر جدید در `configs`
- [ ] `npx wrangler secret put UPSTREAM_API_KEYS -c providers/<name>/wrangler.toml`
- [ ] `npm run test:all` → سبز
- [ ] `npm run check` → سبز (خارج از سندباکس)
- [ ] دیپلوی: اول providerها، بعد راوتر
- [ ] تست واقعی `/c/chat/completions` + تست استریم

با تکمیل این چک‌لیست، Provider جدید از تمام مزیت‌های هسته بهره‌مند است: استخر کلید با قرنطینه، failover خودکار، قطع‌کننده‌ی مدار، احترام به `Retry-After`، استریم SSE با شمارش usage، سهمیه‌ی روزانه/ماهانه، و GC رزروهای گیرکرده — بدون حتی یک خط منطق اضافه.
