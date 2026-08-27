---
title: Lifecycle `detectLegacyStateMigrations` adapter
category: Webhook security
source: migrated from AGENTS.md
---
- **Lifecycle `detectLegacyStateMigrations` adapter.** `ChannelLifecycleAdapter` can be derived as `NonNullable<ChannelPlugin["lifecycle"]>` from `openclaw/plugin-sdk/channel-core` and lives on `base` (forwarded by `createChatChannelPlugin`'s `{ ...params.base }` spread). Its `detectLegacyStateMigrations({ cfg, env, stateDir, oauthDir })` returns `ChannelLegacyStateMigrationPlan[]` from `openclaw/plugin-sdk/channel-contract`. The plan is a discriminated union: `{ kind: "copy"|"move", label, sourcePath, targetPath }` for file-on-disk moves/copies, or `{ kind: "plugin-state-import", …, readEntries: () => {key, value, ttlMs?}[] }` for importing legacy entries into the SDK's plugin-state store. A plugin channel with no on-disk legacy state returns `[]` today — the wiring exists so a future state file (dedupe tombstones, OAuth token cache, chat-id cache) can be migrated by adding a plan entry instead of a new adapter. `ChannelLegacyStateMigrationPlan` is also re-exported from `openclaw/plugin-sdk/channel-contract`.
