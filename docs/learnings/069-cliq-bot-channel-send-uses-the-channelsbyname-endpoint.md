---
title: Cliq bot→channel send uses the channelsbyname endpoint, NOT the bot-message endpoint (issue #26)
category: Zoho Cliq specifics
files: [src/api.ts]
apis: [/api/v2/bots/{botId}/message, /api/v2/channelsbyname/{channel_unique_name}/message, ZohoCliq.Channels.UPDATE, ZohoCliq.Webhooks.CREATE]
issues: [#26]
source: migrated from AGENTS.md
---
- **Cliq bot→channel send uses the channelsbyname endpoint, NOT the bot-message endpoint (issue #26).** `POST /api/v2/bots/{botId}/message` accepts `userids` (DMs) but REJECTS `chatid` with `{"code":"extra_key_found","message":"'chatid' is an extra key in the JSON Object."}`. Channel posts must go to `POST /api/v2/channelsbyname/{channel_unique_name}/message?bot_unique_name={botId}` with body `{ text }` (no `chatid`/`userids` key) and the `ZohoCliq.Channels.UPDATE` scope (separate from `ZohoCliq.Webhooks.CREATE`). The bot identity is supplied as a `bot_unique_name` QUERY PARAM, not a body field. The `to` for a non-DM send MUST be the channel unique name (it's in the URL path) — the inbound `responseTarget` therefore prefers `channel:<channelUniqueName>` over `chat:<chatId>`. Media uploads to a channel use the same URL with a `multipart/form-data` body (`text` + `attachments`, no `chatid`/`userids`). The bot must be a participant of the target channel or Cliq rejects the post. Pattern confirmed in the bernesto reference repo (`src/api.ts:sendCliqChannelMessage`).
