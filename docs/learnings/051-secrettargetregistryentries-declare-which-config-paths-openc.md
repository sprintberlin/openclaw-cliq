---
title: `secretTargetRegistryEntries` declare which config paths `openclaw secrets` recognizes
category: Secrets (`openclaw secrets audit/apply/reload`)
source: migrated from AGENTS.md
---
- **`secretTargetRegistryEntries` declare which config paths `openclaw secrets` recognizes** (audit scans for plaintext at those paths; apply rewrites plaintext → SecretRef; configure generates candidates). Each entry is `{ id, targetType, configFile:"openclaw.json", pathPattern, secretShape:"secret_input", expectedResolvedValue:"string", includeInPlan, includeInConfigure, includeInAudit }`. Cliq is single-account (`dmAllowFromMode:"topOnly"`), so only channel-root paths are registered (no `accounts.*` variants) — `clientSecret`, `webhookSecret`, `refreshToken`.
