# راهنمای نصب و استقرار OmniRoute Cloudflare Proxy

# ۰. نصب وابستگی‌ها (بار اول)
npm install

# ۱. لاگین (اگر لازم است)
wrangler login

# ۲. ایجاد KV برای bai — مقدار id خروجی را یادداشت کنید
wrangler kv namespace create "USAGE_BAI"

# ۳. ایجاد KV برای dahl — مقدار id خروجی را یادداشت کنید
wrangler kv namespace create "USAGE_DAHL"

# ۴. قرار دادن idها در فایل‌های wrangler.toml:
#    - id مربوط به USAGE_BAI  →  providers/bai/wrangler.toml
#    - id مربوط به USAGE_DAHL →  providers/dahl/wrangler.toml
#
#    ⚠️ نکات مهم:
#       - «USAGE_BAI/USAGE_DAHL» فقط عنوان namespace است؛ binding در کد
#         «KV_USAGE» است و نباید تغییر کند. فقط id را جایگزین کنید.
#       - id دو provider را با هم جابه‌جا نکنید و از یک id مشترک استفاده
#         نکنید؛ آمار مصرف و مسدودسازی کلیدهای هر provider مستقل است.

# ۵. تنظیم سکریت‌ها
wrangler secret put ROUTER_API_KEY -c router/wrangler.toml
wrangler secret put UPSTREAM_API_KEYS -c providers/bai/wrangler.toml
wrangler secret put UPSTREAM_API_KEYS -c providers/dahl/wrangler.toml

# ۶. استقرار (ترتیب مهم است: ابتدا providerها، سپس راوتر)
npm run deploy:providers
npm run deploy:router

# ۷. بررسی سلامت پس از استقرار
curl https://<workers-dev-domain-of-router>/health
