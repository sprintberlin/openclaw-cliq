---
title: `ChannelOutboundContext` has only `cfg`, `to`, `text`, `accountId`
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **`ChannelOutboundContext` has only `cfg`, `to`, `text`, `accountId`** as its *essential* fields — no resolved `account`, no `chatType`. Outbound must resolve the account from `cfg` + `accountId`, and cannot tell DM from channel (defaults to `chatid`). The inbound dispatch path DOES know chat type and passes `isDm` correctly. (The runtime `createChannelOutboundContextBase` also sets `replyToId`, `replyToIdSource`, `replyToMode`, `formatting`, `threadId`, `identity`, `silent`, `gatewayClientScopes`, `mediaAccess`, etc. on the ctx — see `outbound.types-B7fkjz65.d.ts:105` — so an outbound adapter CAN read `ctx.replyToId`/`ctx.threadId` for logging/correlation, even though it still can't tell DM from group without the `to`-prefix trick.)
