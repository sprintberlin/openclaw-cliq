---
title: `openclaw/plugin-sdk/compat` is DEPRECATED
category: Gateway smoke / real-loader verification
source: migrated from AGENTS.md
---
- **`openclaw/plugin-sdk/compat` is DEPRECATED** (`OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED` warning emitted on import unless `VITEST=true` or `OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1`). The message says "External plugins may keep compat temporarily while migrating" — it's a warning, not a load failure (smoke still passes), but it pollutes the gateway log. Prefer the focused subpaths. For group-policy helpers, `openclaw/plugin-sdk/channel-policy` exports `resolveChannelGroupRequireMention`, `resolveChannelGroupToolsPolicy`, `resolveChannelGroupPolicy`, `resolveToolsBySender`, and the `GroupToolPolicyConfig`/`GroupToolPolicyBySenderConfig`/`ChannelGroupPolicy` types — note `openclaw/plugin-sdk/config-runtime` exports `resolveChannelGroupRequireMention` + `resolveChannelGroupPolicy` but NOT `resolveChannelGroupToolsPolicy`, so `channel-policy` is the right focused subpath when you need the tool-policy resolver.
