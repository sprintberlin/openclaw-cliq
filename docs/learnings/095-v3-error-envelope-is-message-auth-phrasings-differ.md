---
title: v3 error envelope is `{"message":"…"}` — auth phrasings differ from v2
category: Zoho Cliq specifics
apis: [/api/v3/bots/{BOT_UNIQUE_NAME}/messages,/api/v3/channelsbyname/{name}/messages,/api/v2/bots/{botId}/message,/api/v2/channelsbyname/{channel_unique_name}/message]
source: issue #67
---
- **v3 error envelope is `{"message":"…"}` — auth phrasings differ from v2.** Every non-2xx v3 response is a JSON object whose only stable field is a top-level `message` string (the v3 Errors docs list only `message`; some endpoints add `code`/`details`, but `message` is always the human-readable text). v2 returns a mix of opaque strings and ad-hoc JSON. The v3 auth-failure *phrasings* differ from v2's tokens: a v3 401 is `"Request was rejected because of invalid AuthToken."` and a 403 is `"The user does not have enough permission…"`, so the v2 pattern set (`/invalid_token/`, `/unauthorized/`, `/access\s*denied/`) does NOT match a v3 envelope. `src/cliq-error.ts` (`parseCliqErrorBody`) extracts the `message` field so `appendCliqDataCenterHint` (region.ts) and `classifyCliqSendResponse` (send-retry.ts) match against the extracted text, and the auth-failure patterns include `/invalid\s+authtoken/` + `/not\s+enough\s+permission/` so v3 auth failures trigger the data-center hint just like v2.
