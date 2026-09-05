# ۱. لاگین (اگر لازم است)
wrangler login

# ۲. ایجاد KV برای bai
wrangler kv namespace create "USAGE_BAI"

# ۳. ایجاد KV برای dahl
wrangler kv namespace create "USAGE_DAHL"

# ۴. IDهای دریافتی را در فایل‌های wrangler.toml قرار دهید.

# ۵. تنظیم سکریت‌ها
wrangler secret put ROUTER_API_KEY -c router/wrangler.toml
wrangler secret put UPSTREAM_API_KEYS -c providers/bai/wrangler.toml
wrangler secret put UPSTREAM_API_KEYS -c providers/dahl/wrangler.toml

# ۶. استقرار
npm run deploy:providers
npm run deploy:router