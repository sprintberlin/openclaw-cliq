---
title: Bot subscriber membership is readable only to the creator or an organization administrator
category: Zoho Cliq specifics
files: [src/bot-inspect.ts, src/client.ts, src/setup-onboarding.ts]
apis: [/api/v3/bots, /api/v3/bots/{BOT_ID}, /api/v3/bots/{BOT_ID}/subscribers, ZohoCliq.Bots.READ]
issues: [#99, #94]
---
- **A bot's documented metadata and a user's subscription membership are different read boundaries.** `GET /api/v3/bots/{BOT_ID}` exposes `status`, `scope`, `subscriber_count`, handler summaries, and channel participation, but membership comes from the cursor-paginated `/subscribers` route, whose access is limited to the bot creator or an organization administrator; a denied subscriber read leaves membership `unknown` even when visibility and active state are known. A user absent from the returned list is `not_subscribed` only after the cursor walk completes — an unreadable or truncated list must never be treated as evidence of absence.
