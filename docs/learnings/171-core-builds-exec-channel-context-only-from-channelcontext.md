---
title: Core builds exec OPENCLAW_CHANNEL_CONTEXT only from ChannelContext
files: src/inbound.ts
apis: [finalizeInboundContext, ChannelContext, OPENCLAW_CHANNEL_CONTEXT, SenderId]
---

OpenClaw Core projects a channel turn's identity into the `exec` tool's subprocess environment (`OPENCLAW_CHANNEL_CONTEXT`) only from the `ChannelContext` field (`{ sender?: { id? }, chat?: { id? } }`) passed to `finalizeInboundContext`; `SenderId`/`SenderName`/`ChatType` are never consulted, and only `sender.id` and `chat.id` survive the projection (extra keys are dropped, non-string/blank values dropped via `normalizeOptionalString`). The env var is merged after `execParams.env` and plugin env, so a model-requested env of the same name is always overwritten by the channel-owned value. A plugin channel that omits `ChannelContext` leaves the variable unset for every channel-origin exec run (issue #347).
