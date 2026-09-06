# PolyRoute v5 — Release Checklist

## Automated checks

Run:

```bash
npm ci
npm run test:all
npm run check
```

`npm run test:all` must report:

- syntax: PASS
- static configuration: PASS
- V5 verification: **70 passed, 0 failed** (or higher if more tests are added)

`npm run check` must complete successfully for all three Wrangler configurations.

## Required staging checks

1. Deploy provider Workers to a staging account/environment.
2. Verify each provider has the correct `UPSTREAM_API_KEYS` secret.
3. Send successful JSON and SSE requests.
4. Inject 401, 403, 429, 408, 425, 500, 502, 503, 504 and network/timeout failures.
5. Verify failover, Retry-After quarantine and recovery.
6. Verify POST/PUT/PATCH bodies survive failover.
7. Verify daily/monthly quota rollover.
8. Verify Durable Object state survives Worker eviction/restart.
9. Verify no API secret is returned in client responses or logs.
10. Run a controlled concurrency/load test before public release.

## Production gate

Do **not** publish as a public stable router until:

- `npm ci` succeeds in a clean environment.
- `npm run test:all` is green.
- `npm run check` is green.
- Staging tests against the real Cloudflare Workers runtime are green.
- Upstream provider behavior has been verified for the exact models/endpoints you expose.
