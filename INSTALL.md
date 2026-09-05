# راهنمای کامل نصب — Cloudflare Router v4

این راهنما مخصوص پروژه‌ی **v4** (همین پوشه) است و مرحله‌به‌مرحله تا نصب کامل و تست واقعی پیش می‌رود. همه‌ی دستورها را **از داخل همین پوشه** اجرا کنید:

```powershell
cd "C:\Users\Pezhman\Downloads\Pezhman - Copy\cloudflare-router\New"
```

> **نکته‌ی Windows:** اگر `npm` خطای «running scripts is disabled» داد، به‌جای آن از `npm.cmd` استفاده کنید یا یک‌بار این را اجرا کنید:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

---

## پیش‌نیازها

| نیاز | بررسی |
|------|-------|
| Node.js نسخه ۲۰ یا بالاتر | `node --version` |
| npm | `npm --version` |
| حساب Cloudflare | [dash.cloudflare.com](https://dash.cloudflare.com) — پلن رایگان کافی است (Durable Object با SQLite در پلن رایگان پشتیبانی می‌شود) |
| کلید API از BAI و Dahl | از پنل هر سرویس |

---

## مرحله ۰ — آماده‌سازی اطلاعات

قبل از هر دستوری، این سه مورد را آماده کنید:

**۱) کلیدهای Provider** — از پنل BAI و Dahl. اگر چند کلید دارید، با کاما و **در یک خط**:
```
key1,key2,key3
```

**۲) یک کلید گیت‌وی قوی برای راوتر** — در PowerShell بسازید و یادداشت کنید:
```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

**۳) بررسی دو مقدار در فایل‌های کانفیگ** (اگر با مستندات فعلی provider فرق دارند، قبل از deploy اصلاح کنید):

| فایل | متغیر | مقدار فعلی | شرط درست بودن |
|------|-------|------------|----------------|
| `providers/bai/wrangler.toml` | `UPSTREAM_BASE_URL` | `https://api.b.ai/v1` | آدرس واقعی API سازگار با OpenAI باید این باشد |
| `providers/bai/wrangler.toml` | `AUTH_MODE` | `bearer` | اگر BAI کلید را با هدر `x-api-key` می‌خواهد → `x-api-key` |
| `providers/dahl/wrangler.toml` | `UPSTREAM_BASE_URL` | `https://inference.dahl.global/v1` | آدرس واقعی Dahl |
| `providers/dahl/wrangler.toml` | `AUTH_MODE` | `bearer` | اگر Dahl کلید را با هدر `x-api-key` می‌خواهد → `x-api-key` |

هر تغییری در این مقادیر، **بعداً باید redeploy** شود (متغیرها در زمان build باندل می‌شوند).

---

## مرحله ۱ — نصب وابستگی‌ها

```powershell
npm install
```

✅ **خروجی موردانتظار:** `added 34 packages...` (بدون خطای `EALLOWSCRIPTS` — اگر دیدید، متغیر محیطی `npm_config_allow_scripts` را پاک کنید: `Remove-Item Env:npm_config_allow_scripts`)

---

## مرحله ۲ — اثبات سلامت کد (قبل از هر deploy)

```powershell
node tests/v4-verify.mjs
```

✅ **خروجی موردانتظار:** عبارت `═══ نتیجه v4 فیکس‌شده: 45 موفق، 0 ناموفق ═══`

این تست کد واقعی را با Durable Object و SQLite واقعی اجرا می‌کند. اگر این مرحله سبز نبود، جلوتر نروید.

بررسی اختیاری باندل (بدون deploy واقعی):

```powershell
npm run check
```

✅ **خروجی موردانتظار:** سه‌بار `Total Upload: ...` و `--dry-run: exiting now.`

---

## مرحله ۳ — ورود به Cloudflare

```powershell
npx wrangler login
```

مرورگر باز می‌شود → تأیید کنید. اگر مرورگر باز نشد، آدرس نمایش‌داده‌شده در ترمینال را دستی در مرورگر باز کنید.

بررسی ورود:

```powershell
npx wrangler whoami
```

✅ **خروجی موردانتظار:** ایمیل حساب و نام اکانت شما.

---

## مرحله ۴ — تنظیم سه Secret

**ترتیب مهم است: اول secrets، بعد deploy.** (اگر wrangler پرسید worker وجود ندارد و می‌سازد؟ → با `y` تأیید کنید.)

**۴-۱) کلیدهای BAI:**
```powershell
npx wrangler secret put UPSTREAM_API_KEYS -c providers/bai/wrangler.toml
```
وقتی مقدار را خواست، لیست کلیدهای BAI را با کاما paste کنید و Enter.

**۴-۲) کلیدهای Dahl:**
```powershell
npx wrangler secret put UPSTREAM_API_KEYS -c providers/dahl/wrangler.toml
```

**۴-۳) کلید گیت‌وی راوتر** (همان که در مرحله ۰ ساختید):
```powershell
npx wrangler secret put ROUTER_API_KEY -c router/wrangler.toml
```

✅ **خروجی موردانتظار هر سه:** `Success! Uploaded secret UPSTREAM_API_KEYS` (یا `ROUTER_API_KEY`)

> هرگز مقدار secrets را در فایل، Git یا چت قرار ندهید.

---

## مرحله ۵ — Deploy

**اول providerها، بعد راوتر** (binding راوتر به نام providerها وصل است):

```powershell
npm run deploy:providers
```

✅ **خروجی موردانتظار:** دو‌بار `Uploaded omniroute-provider-bai` / `omniroute-provider-dahl` + پیام مهاجرت Durable Object (`v1`) + نسخه/URL.

⚠️ providerها عمداً هیچ URL عمومی ندارند (`workers_dev=false`) — این طبیعی و امن است.

```powershell
npm run deploy:router
```

✅ **خروجی موردانتظار:** `Uploaded omniroute-master-proxy` و مهم‌تر از همه:

```
https://omniroute-master-proxy.<subdomain>.workers.dev
```

**این URL را کپی و ذخیره کنید** — آدرس عمومی سرویس شماست. (یک‌خطا یا خیر: `npm run deploy` هر دو را پشت‌سرهم انجام می‌دهد.)

---

## مرحله ۶ — تأیید نصب (سه تست واقعی)

در همه‌ی دستورهای زیر، `https://omniroute-master-proxy.<subdomain>.workers.dev` را با URL مرحله ۵ و `ROUTER_API_KEY` را با کلید گیت‌وی خودتان جایگزین کنید.

**۶-۱) Health check:**
```powershell
Invoke-RestMethod "https://omniroute-master-proxy.<subdomain>.workers.dev/health"
```
✅ **موردانتظار:** `ok : True` و `version : 4.0.0`

**۶-۲) درخواست واقعی غیراستریم** (به BAI از طریق مسیر `/a/...`):

فایل `body.json` بسازید (کنار پروژه) با محتوای زیر — `MODEL-NAME` را با نام مدلی که BAI واقعاً ارائه می‌دهد عوض کنید:
```json
{
  "model": "MODEL-NAME",
  "messages": [{ "role": "user", "content": "سلام" }]
}
```
```powershell
curl.exe -s "https://omniroute-master-proxy.<subdomain>.workers.dev/a/chat/completions" -H "Authorization: Bearer ROUTER_API_KEY" -H "Content-Type: application/json" -d "@body.json"
```
✅ **موردانتظار:** پاسخ JSON عادی chat completion (همان شکل OpenAI).

**۶-۳) درخواست استریم SSE** — فایل `body-stream.json` با `"stream": true`:
```json
{
  "model": "MODEL-NAME",
  "messages": [{ "role": "user", "content": "یک داستان کوتاه بگو" }],
  "stream": true
}
```
```powershell
curl.exe -N "https://omniroute-master-proxy.<subdomain>.workers.dev/a/chat/completions" -H "Authorization: Bearer ROUTER_API_KEY" -H "Content-Type: application/json" -d "@body-stream.json"
```
✅ **موردانتظار:** قطعات متن به‌صورت تدریجی چاپ شود (رویدادهای `data: {...}`) و در انتها `data: [DONE]`. اگر متن ناگهانی و یکجا آمد، استریم نیست — به عیب‌یابی مراجعه کنید.

**تست Dahl** هم همین است با مسیر `/b/...`.

اگر هر سه سبز بود — **نصب ۱۰۰٪ کامل است.** 🎉

---

## مرحله ۷ (اختیاری) — لاگ زنده حین تست

در یک ترمینال جدا:
```powershell
npx wrangler tail -c providers/bai/wrangler.toml --format pretty
npx wrangler tail -c router/wrangler.toml --format pretty
```
بعد درخواست بزنید و لاگ‌ها را ببینید (`Retry attempt...`، `Released key...` و…).

---

## مرحله ۸ (توصیه‌شده قبل از استفاده‌ی جدی) — امنیت و پایداری

- **WAF / Rate Limiting کلودفلر** را روی دامنه‌ی راوتر فعال کنید (داشبورد → Security).
- **دامنه‌ی اختصاصی** (اختیاری): داشبورد → Workers → `omniroute-master-proxy` → Settings → Domains & Routes → Add Custom Domain.
- **پایش هزینه:** داشبورد → Workers & Pages → Metrics. مصرف DO (هماهنگی کلیدها) بسیار جزئی است؛ هزینه‌ی اصلی، خود فراخوانی‌های upstream است.

---

## نگهداری آینده

**تعویض/افزودن کلیدهای provider:** فقط دوباره secret را بگذارید — DO خودش کلیدهای جدید را اضافه و حذف‌شده‌ها را پاک می‌کند (نیازی به deploy مجدد نیست):
```powershell
npx wrangler secret put UPSTREAM_API_KEYS -c providers/bai/wrangler.toml
```

**تعویض کلید گیت‌وی:** همان دستور برای `ROUTER_API_KEY` روی راوتر — اعتبارنامه‌های قدیمی فوراً باطل می‌شوند.

**تغییر `AUTH_MODE` یا `UPSTREAM_BASE_URL`:** فایل toml را ویرایش و redeploy کنید.

**به‌روزرسانی کد بعداً:** بعد از هر تغییر، `npm run deploy` و بعد تست مرحله ۶.

---

## عیب‌یابی

| علامت | علت | راه‌حل |
|-------|-----|--------|
| `npm install` → `EALLOWSCRIPTS` | متغیر محیطی `npm_config_allow_scripts` فعال است | `Remove-Item Env:npm_config_allow_scripts` و تلاش مجدد (پروژه فیلد `allowScripts` را درست تنظیم کرده) |
| `npm ...` → «cannot be loaded because running scripts is disabled» | Execution Policy ویندوز | از `npm.cmd` استفاده کنید یا `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| deploy خطای «required secret missing» | secret هنوز نگذاشته‌اید | مرحله ۴ را کامل کنید و deploy را تکرار کنید |
| `/health` → 404 | URL اشتباه یا راوتر deploy نشده | URL دقیق را از خروجی `deploy:router` بردارید |
| هر درخواست → `401 unauthorized` | کلید گیت‌وی اشتباه یا هدر غلط | مقدار دقیق `ROUTER_API_KEY` را با هدر `Authorization: Bearer ...` بفرستید |
| پاسخ `401` از خود provider | کلید upstream نامعتبر | محتوای `UPSTREAM_API_KEYS` را چک کنید (بدون فاصله/خط اضافه)؛ اگر درست بود، بعد از ۱۵ دقیقه (قرنطینه) دوباره امتحان کنید یا کلید را عوض کنید |
| `503 no_healthy_api_key` | همه‌ی کلیدها در قرنطینه | کلیدهای سالم بگذارید؛ یا صبر کنید cooldown تمام شود |
| `502 upstream_unavailable` / `upstream_timeout` | upstream از دسترس خارج یا کند | `UPSTREAM_BASE_URL` را مستقیم با curl تست کنید؛ تایم‌اوت را با `UPSTREAM_TIMEOUT_MS` در toml تنظیم کنید |
| پاسخ JSON از provider → `401/403` با وجود کلید درست | `AUTH_MODE` نادرست | در toml به `x-api-key` (یا برعکس) تغییر دهید و redeploy |
| استریم تدریجی نیست (همه یکجا) | کلاینت/پروکسی واسط بافر می‌کند | با `curl.exe -N` مستقیم تست کنید؛ اگر مستقیم روان بود، مشکل از کلاینت شماست نه راوتر |
| خطای مهاجرت DO هنگام deploy | tag مهاجرت تغییر کرده | `[[migrations]]` را دست نزنید — همان `v1` بماند |
| `503 provider_binding_unavailable` | provider deploy نشده یا نامش عوض شده | `npm run deploy:providers` را اجرا کنید؛ نام‌ها در `[[services]]` راوتر باید با `name` providerها یکی باشد |

---

## چک‌لیست نهایی نصب

- [ ] `node tests/v4-verify.mjs` → 45 موفق، 0 ناموفق
- [ ] `npx wrangler whoami` → حساب درست
- [ ] سه secret گذاشته شد (BAI / Dahl / ROUTER_API_KEY)
- [ ] `AUTH_MODE` و `UPSTREAM_BASE_URL` هر دو provider با مستندات واقعی‌شان مطابقت دارد
- [ ] `npm run deploy:providers` سپس `npm run deploy:router` بدون خطا
- [ ] URL راوتر ذخیره شد
- [ ] `/health` → `ok: true`
- [ ] درخواست غیراستریم `/a/...` → پاسخ 200 معتبر
- [ ] درخواست استریم `/a/...` → متن تدریجی + `[DONE]`
- [ ] همان دو تست برای `/b/...`
- [ ] WAF/Rate limiting فعال شد
