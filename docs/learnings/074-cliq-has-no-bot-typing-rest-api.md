---
title: Cliq v3 typing activity is always attributed to the refresh-token owner
category: Zoho Cliq specifics
files: [src/heartbeat.ts, src/capabilities.ts, src/client.ts]
apis: [/api/v3/chats/{CHAT_ID}/activities, ZohoCliq.Chats.UPDATE]
source: Zoho v3 chats API plus second-account UI observation
---
`POST /api/v3/chats/{CHAT_ID}/activities` with `{"action":"typing"}` (also `text_entered` / `text_cleared`) returns empty HTTP 204 and requires `ZohoCliq.Chats.UPDATE` on a user-context refresh token. Cliq renders the indicator as that human token owner, never as the bot; the official endpoint exposes no sender override and rejects `bot_unique_name`. A bare Cliq user id is not a chat id (`chat_access_denied` / HTTP 403); use the inbound `chat.id` (`CT_…`). Activities are limited to 100 req/min/user and exceeding that can lock activity calls for up to 50 minutes. Official API: https://www.zoho.com/cliq/help/restapi/v3/chats/.
