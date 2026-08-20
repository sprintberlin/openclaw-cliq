---
title: Webhook secret verification must be constant-time + single-header
category: Webhook security
source: migrated from AGENTS.md
---
- **Webhook secret verification must fail closed, be constant-time, and use one header.** An absent or unresolved configured secret disables inbound delivery with HTTP 503 and no agent dispatch. A configured secret with a missing or wrong canonical header returns HTTP 401. `crypto.timingSafeEqual` requires equal-length buffers; on a length mismatch run a dummy `timingSafeEqual(b, b)` so the wall-clock cost stays roughly constant (avoids an early-return timing signal). Accept ONLY `x-cliq-webhook-secret` — honoring `Authorization`/`x-webhook-secret` as fallbacks widens the attack surface (a misconfigured proxy forwarding one of them bypasses the check). The Deluge handler is documented to send exactly `x-cliq-webhook-secret`.
