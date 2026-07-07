---
title: Deluge payload is inconsistent
category: Zoho Cliq specifics
source: migrated from AGENTS.md
---
- **Deluge payload is inconsistent:** `message` can be a string or `{text,id,time}`; channel info lives under `payload.channel`, `payload.chat.channel_unique_name`, or is inferable from `chat.type==="channel"`/`chat.title`; some configs wrap everything in `params`. `parseCliqWebhookPayload` tolerates all of these. A `-B` suffix on a chat id indicates a bot DM, but group detection via `chat.type==="channel"` is more robust than the suffix.
