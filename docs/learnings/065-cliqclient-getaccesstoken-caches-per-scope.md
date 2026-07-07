---
title: `CliqClient.getAccessToken` caches per-scope
category: Zoho Cliq specifics
apis: [ZohoCliq.Users.READ, ZohoCliq.Webhooks.CREATE]
source: migrated from AGENTS.md
---
- **`CliqClient.getAccessToken` caches per-scope.** The original implementation cached a single `accessToken`/`tokenExpiresAt` pair and ignored the `scope` argument on cache hits — so the first call (`ZohoCliq.Webhooks.CREATE`) would be returned verbatim for a later `ZohoCliq.Users.READ` directory call, silently using the wrong-scope token. The cache is now a `Map<scope, {token,expiresAt}>`. When adding any new Cliq REST surface that needs a different scope (directory reads, future reactions/actions), pass the scope explicitly to `getAccessToken` — it will mint + cache a separate token per scope.
