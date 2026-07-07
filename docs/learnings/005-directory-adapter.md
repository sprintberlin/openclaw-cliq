---
title: `directory` adapter
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **`directory` adapter** is forwarded by `createChatChannelPlugin` (it does `{ ...params.base, ... }`), so place `directory` on `base` — NOT on the top-level params (which only accept `base/security/pairing/threading/outbound`). `createChannelDirectoryAdapter` is exported from `openclaw/plugin-sdk/directory-runtime` (NOT `channel-core`); it takes `{ self?, listPeers?, listGroups?, listPeersLive?, listGroupsLive?, listGroupMembers? }` and returns a `ChannelDirectoryAdapter`. The list callbacks receive `{ cfg, accountId?, query?, limit?, runtime }` where `runtime` is the SDK's `RuntimeEnv` (we don't need it — cast to `never` in tests). `ChannelDirectoryEntry`/`ChannelDirectoryEntryKind` (`"user" | "group" | "channel"`) are also re-exported from `directory-runtime`. The adapter is a read-only convenience surface: it must NEVER throw — degrade API failures to an empty list so `openclaw directory` doesn't crash.
