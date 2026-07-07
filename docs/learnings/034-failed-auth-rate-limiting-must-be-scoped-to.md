---
title: Failed-auth rate limiting must be scoped to the 401 path only
category: Webhook security
source: migrated from AGENTS.md
---
- **Failed-auth rate limiting must be scoped to the 401 path only.** A per-IP fixed window that is consulted (and `hit()`) only when verification fails can never throttle legitimate Cliq delivery, even under a flood of valid webhooks. Process-local is fine for single-gateway deployments; multi-replica would need a shared store (Redis), out of scope.
