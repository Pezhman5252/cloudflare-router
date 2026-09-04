# OmniRoute Cloudflare Proxy V3

Purpose: use Cloudflare as the Base URL endpoint inside OmniRoute. OmniRoute sends its normal API requests to the selected Base URL; Cloudflare routes them to the configured provider.

Configured routes:

- `/a` -> `https://api.b.ai/v1`
- `/b` -> `https://inference.dahl.global/v1`

Examples:

- `https://ROUTER/a/chat/completions` -> `https://api.b.ai/v1/chat/completions`
- `https://ROUTER/b/chat/completions` -> `https://inference.dahl.global/v1/chat/completions`

Architecture:

OmniRoute -> Master Router Worker -> Service Binding -> Provider Worker -> Provider API

Provider API keys are stored as Cloudflare Worker Secrets.
