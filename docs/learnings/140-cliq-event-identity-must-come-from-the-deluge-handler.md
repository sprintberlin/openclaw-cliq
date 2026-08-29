---
title: Cliq event identity must be minted by the Deluge handler, not derived from content
category: Zoho Cliq inbound / dedupe
files: [src/bot-provisioning.ts, src/inbound.ts, src/dedupe.ts]
apis: [eventId, buildSyntheticMessageId, buildCliqDedupeKey, MessageSid]
issues: [#196]
---

Cliq's bot Message Handler exposes no native message, event, or delivery id, so any content-derived identity (`syn:<hash>`) makes a deliberate repeat indistinguishable from a redelivery — and OpenClaw core keeps `MessageSid` in its own 20-minute inbound dedupe, so a plugin-side short TTL cannot fix the disagreement. The fix is a transport identity minted inside the generated Deluge script (`payload.put("eventId", …)`), created once per handler execution and kept in the POST body so an exact retry reuses it. Resolve identity as `message.id` → `eventId` → legacy `syn:` hash, and treat an `eventId` like a real message id (long replay TTL, not the 60s content TTL). If Zoho starts a new handler execution it mints a new event id; that is intentionally a separate event because the Message Handler exposes no platform id that could prove otherwise. Existing installs need a handler repair, so the setup planner must treat a recognizable script with no `eventId` as stale rather than in sync.
