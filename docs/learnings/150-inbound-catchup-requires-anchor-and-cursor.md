---
title: Inbound chat catch-up requires an anchored bounded window and a durable opaque cursor
files:
  - src/inbound-catchup.ts
  - src/inbound-catchup-store.ts
  - src/client.ts
  - index.ts
apis:
  - /api/v2/chats/{chatId}/messages
  - ZohoCliq.Messages.READ
source: issue #229
---

`GET /api/v2/chats/{chatId}/messages` is a user-context `ZohoCliq.Messages.READ` endpoint with a 15-request-per-minute-per-user limit and a bounded `limit` query; it is suitable only as an event-triggered safety net, never a polling transport. Cliq’s public response example proves `data[]` records carry `sender.{id,name}`, native `id`, numeric `time`, `type`, and file `content`; the live 2026-09-05 incident separately proved a missed `message_type: "forwarded"` record carries `forward_info` / original `content.text` even when no OpenClaw turn exists.

A recovery scan must establish both a same-sender/same-text current-live anchor inside the bounded newest-first window and a persisted opaque native-message cursor before dispatching anything. First enablement only stores the current anchor; later scans dispatch the oldest-first gap strictly between cursor and anchor through the existing native-id dedupe claim. If the anchor, cursor state, read, parse, or self/bot filter is unavailable, replay nothing and leave the live webhook turn unchanged. Store cursor state keyed by a hash of account/chat ids and never log message text or identifying conversation values.
