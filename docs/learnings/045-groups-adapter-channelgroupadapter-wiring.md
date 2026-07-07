---
title: `groups` adapter (`ChannelGroupAdapter`) wiring
category: Gateway smoke / real-loader verification
source: migrated from AGENTS.md
---
- **`groups` adapter (`ChannelGroupAdapter`) wiring.** The type is `ChannelGroupAdapter` (exported from `openclaw/plugin-sdk/channel-runtime`, NOT `channel-core`/`channel-contract`); `ChannelGroupContext` is exported from both `channel-runtime` and `channel-contract`. The adapter lives on `base` (forwarded by `createChatChannelPlugin`'s `{ ...params.base, ... }`) — NOT on the top-level params. `resolveRequireMention(params)` → `boolean | undefined` (return `undefined` to let the runtime default apply); `resolveToolPolicy(params)` → `GroupToolPolicyConfig | undefined`. The runtime calls `plugin.groups?.resolveRequireMention?.({ cfg, groupId, groupChannel, groupSpace, accountId })` from `get-reply`'s `resolveGroupRequireMention`, where `groupId` is derived from `ctx.From` via `extractExplicitGroupId` (with `groupChannel`/`groupSpace` from `ctx.GroupChannel`/`ctx.GroupSubject` as fallbacks).
