---
title: `resolveDefaultSecretProviderAlias` is NOT in the light secret subpaths
category: Secrets (`openclaw secrets audit/apply/reload`)
source: migrated from AGENTS.md
---
- **`resolveDefaultSecretProviderAlias` is NOT in the light secret subpaths** — it lives in `openclaw/plugin-sdk/provider-auth` (heavy) and `ref-contract-*.js` (internal). For env-only sync resolution, inline it: `secrets.defaults?.env?.trim() || "default"` (the `DEFAULT_SECRET_PROVIDER_ALIAS` constant).
