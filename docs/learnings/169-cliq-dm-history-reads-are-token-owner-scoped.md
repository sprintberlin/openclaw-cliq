---
title: Cliq DM history reads can fail on active lanes
category: Zoho Cliq specifics
files: [src/client.ts, src/inbound-quote.ts, src/inbound.ts]
apis: [/api/v2/chats/{chatId}/messages, ZohoCliq.Messages.READ, operation_failed]
---

- **Cliq history reads (`/api/v2/chats/{chatId}/messages`) can fail on some active lanes.** In one live check (#339, EU org) the token owner's own DM lane and a channel returned 200 while two other users' active DM lanes returned 400 `{"code":"operation_failed"}` under both `refresh_token` and `client_credentials` grants. `operation_failed` is not a documented error code and the same result under both grants does not identify a cause, so recovery must log only HTTP status + allow-listed code (never chat ids, message text, or raw provider bodies, which can echo secrets) and degrade without claiming the reason. `ZohoCliq.Chats.READ` is a separate, non-retroactive consent scope and the v2 single-chat detail endpoint is undocumented; the documented detail endpoint is v3 `GET /api/v3/chats/{CHAT_ID}`.
