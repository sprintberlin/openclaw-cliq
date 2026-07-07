---
title: Cliq directory endpoints
category: Zoho Cliq specifics
apis: [/api/v2/channels, /api/v2/users, ZohoCliq.Channels.READ, ZohoCliq.Users.READ]
source: migrated from AGENTS.md
---
- **Cliq directory endpoints:** `GET /api/v2/users` (scope `ZohoCliq.Users.READ`) returns `{ users: [...] }`; `GET /api/v2/channels` (scope `ZohoCliq.Channels.READ`) returns `{ channels: [...] }`. Pagination via `from` (offset) + `limit` query params, max page size 200. Field names are inconsistent across API versions: user id is `id` OR `user_id`; user name needs `first_name`+`last_name` joined (fall back to `display_name`/`name`/`email`); channel id is `id` OR `channel_id`; channel name is `display_name`/`name`/`unique_name` (the `unique_name` is the handle bots target as `cliq:channel:<unique_name>`). Parse defensively and skip records with no resolvable id.
