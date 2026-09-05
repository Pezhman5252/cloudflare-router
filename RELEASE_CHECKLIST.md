# چک‌لیست انتشار v4

## قبل از استقرار

- [ ] `npm install`
- [ ] `node tests/v4-verify.mjs` → باید `45 موفق، 0 ناموفق` بدهد (کد واقعی + SQLite واقعی + شبیه‌سازی دقیق API واقعی DO SQL)
- [ ] `npm run check` (dry-run باندل هر سه worker)
- [ ] در `providers/bai/wrangler.toml` و `providers/dahl/wrangler.toml`: `AUTH_MODE` را با قرارداد واقعی provider چک کنید (`bearer` یا `x-api-key`)
- [ ] در `router/wrangler.toml` مطمئن شوید `workers_dev=true` است (دسترسی عمومی راوتر) و کلید `ROUTER_API_KEY` قوی است

## Secrets (هرگز در Git)

- [ ] `ROUTER_API_KEY` → راوتر
- [ ] `UPSTREAM_API_KEYS` (لیست کاما-جدا) → هر دو provider

## ترتیب استقرار

- [ ] اول providerها: `npm run deploy:providers` (مهاجرت Durable Object `v1` با `new_sqlite_classes` خودش اعمال می‌شود)
- [ ] بعد راوتر: `npm run deploy:router`
- [ ] `https://<router>.workers.dev/health` → `200`

## تست staging با کد واقعی

- [ ] JSON معمولی روی هر دو provider (`/a/...` و `/b/...`)
- [ ] SSE استریمینگ (پاسخ باید روان برسد، نه 502 — قبلاً باگ بحرانی بود)
- [ ] failover واقعی POST: یک کلید نامعتبر + یک کلید سالم → پاسخ 200 با کلید دوم
- [ ] ۴+ درخواست هم‌زمان → کلیدها بینشان توزیع می‌شوند (نه همه یک کلید)
- [ ] همه‌ی کلیدها 401 → پاس واقعی upstream (نه خطای مبهم)، و بازیابی کلید پس از ۱۵ دقیقه
- [ ] 429 → کلید بعدی + احترام به Retry-After
- [ ] 5xx/timeout → retry/failover محدود، پاس واقعی در انتها
- [ ] 400/404 → passthrough فوری بدون جریمه‌ی کلید
- [ ] قطع اتصال کلاینت حین استریم → رزرو آزاد می‌شود (stats نشان می‌دهد inflight=0)
- [ ] `AUTH_MODE=x-api-key` در صورت نیاز provider

## امنیت

- [ ] هیچ secret ای در Git نیست
- [ ] providerها `workers_dev=false` و `preview_urls=false`
- [ ] WAF/rate limiting کلودفلر جلوی راوتر فعال شود
- [ ] قرارداد دقیق احراز هویت و مدل‌های BAI/Dahl با مستندات فعلی‌شان تطبیق داده شود

## پایش

- [ ] لاگ‌ها را چند روز اول ببینید (`No healthy API key available` = نشانه‌ی اتمام ظرفیت)
- [ ] Wrangler روی نسخه‌ی آزموده pin شود
