---
title: `groups` adapter (`ChannelGroupAdapter`) wiring
category: Gateway smoke / real-loader verification
source: migrated from AGENTS.md
---
- **`groups` adapter (`ChannelGroupAdapter`) wiring.** The adapter type can be derived as `NonNullable<ChannelPlugin["groups"]>` from `openclaw/plugin-sdk/channel-core`; `ChannelGroupContext` is exported from `channel-contract`. The adapter lives on `base` (forwarded by `createChatChannelPlugin`'s `{ ...params.base, ... }`) — NOT on the top-level params. `resolveRequireMention(params)` → `boolean | undefined` (return `undefined` to let the runtime default apply); `resolveToolPolicy(params)` → `GroupToolPolicyConfig | undefined`. The runtime calls `plugin.groups?.resolveRequireMention?.({ cfg, groupId, groupChannel, groupSpace, accountId })` from `get-reply`'s `resolveGroupRequireMention`, where `groupId` is derived from `ctx.From` via `extractExplicitGroupId` (with `groupChannel`/`groupSpace` from `ctx.GroupChannel`/`ctx.GroupSubject` as fallbacks).
