---
title: Cliq v3 has bot typing via chat activities
category: Zoho Cliq specifics
files: [src/heartbeat.ts, src/capabilities.ts]
apis: [/api/v3/chats/{CHAT_ID}/activities, ZohoCliq.Chats.UPDATE]
source: migrated from AGENTS.md; corrected against the v3 chats API
---
- **Cliq v3 does have bot typing via chat activities.** `POST /api/v3/chats/{CHAT_ID}/activities` with JSON body `{"action":"typing"}` (also `text_entered` / `text_cleared`) returns empty HTTP 204 and requires `ZohoCliq.Chats.UPDATE`; operators consent it on the Self Client refresh-token string, although `client_credentials` can report the scope and has produced a live typing 204 too. A bare Cliq user id is not a chat id, and `GET /api/v2/chats` is a different capability that can still return `oauthtoken_scope_invalid` with `Chats.UPDATE`. Activities are limited to 100 req/min/user and exceeding that can lock activity calls for up to 50 minutes; earlier plugin code treated typing as missing and implemented `heartbeat.sendTyping` as an OAuth token pre-warm, which is only a fallback and not evidence that the API is absent. Official API: https://www.zoho.com/cliq/help/restapi/v3/chats/.
