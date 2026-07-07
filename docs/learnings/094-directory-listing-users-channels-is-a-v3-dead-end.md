---
title: Directory listing (users / channels) is a v3 dead end — no org-directory equivalent
category: Zoho Cliq specifics
apis: [/api/v2/users, /api/v2/channels, /api/v3/chats, ZohoCliq.Users.READ, ZohoCliq.Channels.READ]
source: ROADMAP Phase 2 Directory decision (issue #66)
---
- **Directory listing is a v3 dead end.** v3 has NO org-user or channel directory: `GET /api/v3/chats?type=dm|channel` returns only the chats (DMs/channels) the bot has ALREADY conversed with — a semantic change, not a clean swap. `openclaw directory` lists ALL org users / channels (scopes `ZohoCliq.Users.READ` / `ZohoCliq.Channels.READ`), so the v2 `/api/v2/users` + `/api/v2/channels` paths stay v2 indefinitely regardless of the `apiVersion` opt-in. Locked by a regression test in `src/directory.test.ts` (`listUsers` / `listChannels` never hit `/api/v3/`). Ref: v3 Chats <https://www.zoho.com/cliq/help/restapi/v3/chats/>.
