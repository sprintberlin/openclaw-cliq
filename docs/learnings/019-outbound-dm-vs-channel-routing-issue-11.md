---
title: Outbound DM-vs-channel routing (issue #11)
category: OpenClaw Plugin SDK
issues: [#11]
source: migrated from AGENTS.md
---
- **Outbound DM-vs-channel routing (issue #11):** because `ChannelOutboundContext` has no `chatType`, the ONLY way for the outbound `sendText`/`sendMedia` to know DM vs group is to encode it in the `ctx.to` prefix. The inbound path builds `To: cliq:<responseTarget>`; make `responseTarget` chat-type-aware: `user:<senderId>` for DMs, `chat:<chatId>`/`channel:<channelUniqueName>` for groups. The outbound path then runs `normalizeCliqRouteTarget(ctx.to)` to strip the `cliq:<kind>:` prefix and set `isDm` (`user`/`dm` → DM via `userids`; anything else → group via `chatid`). A bare id with no `cliq:` prefix defaults to group (backward compat with raw ids). Without this, `CliqClient.sendMessage` defaults to `chatid` and the agent reply silently never lands in the Cliq DM even though OAuth + bot credentials are valid.
