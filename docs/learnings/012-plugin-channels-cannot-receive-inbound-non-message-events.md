---
title: Plugin channels cannot receive inbound *non-message* events
category: OpenClaw Plugin SDK
issues: [#100447]
source: migrated from AGENTS.md
---
- **Plugin channels cannot receive inbound *non-message* events** (reactions received, typing, presence, read receipts) via the public SDK. The plugin inbound path is message-turn-centric (`api.registerHttpRoute` → `runtime.channel.inbound.run`); `InboundEventKind` exists internally but there is no public adapter/hook for a plugin channel to dispatch or handle a non-message event, and no `heartbeat.setReaction` ack hook. Only bundled channels (Telegram/Discord, in-core) can. So *outbound* agent-invoked reactions work (a REST call), but *inbound* reaction notifications + ack reactions are not buildable without an SDK change. Filed upstream: **openclaw/openclaw#100447**. Tracked in ROADMAP under "Blocked on upstream".
