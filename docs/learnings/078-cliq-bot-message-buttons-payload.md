---
title: Cliq bot-message buttons payload
category: Zoho Cliq specifics
apis: [/api/v2/bots/{botId}/message, /api/v2/channelsbyname/{name}/message, ZohoCliq.Channels.UPDATE, ZohoCliq.Webhooks.CREATE]
issues: [#27]
source: migrated from AGENTS.md
---
- **Cliq bot-message buttons payload.** A bot message (`POST /api/v2/bots/{botId}/message` for DMs, `POST /api/v2/channelsbyname/{name}/message?bot_unique_name={botId}` for channels) accepts a top-level `buttons` array alongside `text` (and `userids` for DMs). Each button is `{ label, type: "+"|"-"|"post", action: "openurl"|"invoke"|"api", url?, data? }`: `action:"openurl"` opens `url` in the browser; `action:"invoke"` posts `data` (a string) back to the Deluge bot handler as an inbound message (the closest Cliq analog to a Telegram callback button). Limits: ≤ 10 buttons per message, labels ≤ 30 chars. Style hints (primary/danger/…) have no Cliq equivalent — they are dropped. Select/menu blocks degrade to a row of buttons (one per option). The same scope rules as `sendMessage` apply (DMs use `ZohoCliq.Webhooks.CREATE` via `client_credentials`; channel posts use `ZohoCliq.Channels.UPDATE` via the refresh-token grant — see issue #27). `CliqClient.sendCard` shares the `sendMessage` retry/logging contract; the log line records the button count (never button contents).
