---
title: The CLI reads a channel's secret contract from a `secret-contract-api` file, not from `base.secrets`
category: Secrets (`openclaw secrets audit/apply/reload`)
files: secret-contract-api.ts,src/secret-contract.ts
apis: loadChannelSecretContractApiForRecord,secretTargetRegistryEntries,collectRuntimeConfigAssignments,openclaw secrets audit
---
- **`openclaw secrets audit`/`apply` do not consult `base.secrets`** — they load a standalone module from the plugin root, trying `secret-contract-api` then `contract-api` with extensions `.js,.mjs,.cjs,.ts,.mts,.cts`, in `dist/` and the root (`loadExternalChannelSecretContractFromRecord`). The module is accepted only if it exports `collectRuntimeConfigAssignments` or `secretTargetRegistryEntries` under **exactly** those names; a plugin-prefixed alias (e.g. `cliqSecretTargetRegistryEntries`) is silently ignored, and the failure is invisible: the loader swallows the error (set `OPENCLAW_DEBUG_CHANNEL_CONTRACT_API=1` to see it) and the audit then reports a config full of plaintext secrets as `"status": "clean"` with `plaintextCount: 0`. A registry entry whose `pathPattern` omits `accounts.*` is likewise never scanned, even though `collectSimpleChannelFieldAssignments` would have rewritten that path on `apply`.
