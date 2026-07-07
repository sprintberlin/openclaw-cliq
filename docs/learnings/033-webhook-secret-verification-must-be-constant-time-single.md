---
title: Webhook secret verification must be constant-time + single-header
category: Webhook security
source: migrated from AGENTS.md
---
- **Webhook secret verification must be constant-time + single-header.** `crypto.timingSafeEqual` requires equal-length buffers; on a length mismatch run a dummy `timingSafeEqual(b, b)` so the wall-clock cost stays roughly constant (avoids an early-return timing signal). Accept ONLY `x-cliq-webhook-secret` — honoring `Authorization`/`x-webhook-secret` as fallbacks widens the attack surface (a misconfigured proxy forwarding one of them bypasses the check). The Deluge handler is documented to send exactly `x-cliq-webhook-secret`.
