---
title: Cliq v3 has bot typing via chat activities
category: Zoho Cliq specifics
files: [src/heartbeat.ts, src/capabilities.ts, src/client.ts]
apis: [/api/v3/chats/{CHAT_ID}/activities, ZohoCliq.Chats.UPDATE]
source: migrated from AGENTS.md; corrected against the v3 chats API; UI unconfirmed 2026-08-28
---
- **Cliq v3 does have bot typing via chat activities.** `POST /api/v3/chats/{CHAT_ID}/activities` with JSON body `{"action":"typing"}` (also `text_entered` / `text_cleared`) returns empty HTTP 204 and requires `ZohoCliq.Chats.UPDATE`; operators consent it on the Self Client refresh-token string. A bare Cliq user id is not a chat id (`chat_access_denied` / HTTP 403); the inbound webhook `chat.id` (`CT_…`) is the address. Activities are limited to 100 req/min/user and exceeding that can lock activity calls for up to 50 minutes. HTTP 204 is API acceptance only: a live 2026-08-28 bot-DM pulse (15× typing plus `text_cleared`, operator had the DM open) showed no client "is typing…" indicator, so UI visibility is unconfirmed and currently looks negative. Official API: https://www.zoho.com/cliq/help/restapi/v3/chats/.
