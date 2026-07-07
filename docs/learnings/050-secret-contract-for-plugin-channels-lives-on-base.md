---
title: Secret contract for plugin channels lives on `base.secrets` (`ChannelSecretsAdapter`),
category: Secrets (`openclaw secrets audit/apply/reload`)
source: migrated from AGENTS.md
---
- **Secret contract for plugin channels lives on `base.secrets` (`ChannelSecretsAdapter`),** forwarded by `createChatChannelPlugin`'s `{ ...params.base }` spread (same as every other non-`security`/`pairing`/`threading`/`outbound` adapter). The type `ChannelSecretsAdapter` + `ChannelPlugin` are exported from `openclaw/plugin-sdk/channel-runtime`; the helpers `collectSimpleChannelFieldAssignments`/`collectNestedChannelFieldAssignments`/`collectConditionalChannelFieldAssignments`/`getChannelSurface`/`isBaseFieldActiveForChannelSurface` + the types `SecretTargetRegistryEntry`/`ResolverContext`/`SecretDefaults` are exported from `openclaw/plugin-sdk/channel-secret-runtime`. The bundled Telegram (`secret-contract-COwIjwBl.js`) and Discord (`secret-config-contract-C0D9kGfJ.js`) channels are the reference implementations.
