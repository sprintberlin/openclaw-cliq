---
title: Cliq bot-message API error envelope is not formally documented
category: Zoho Cliq specifics
files: [src/send-retry.ts]
source: migrated from AGENTS.md
---
- **Cliq bot-message API error envelope is not formally documented**, so classifying a 400 as *format-rejected* (retry plain text) vs *structural* (fatal) is heuristic. Treat 401/403/404 as fatal (auth/bot-not-found), 429/5xx as transient (retry with backoff), and 400 by body pattern: structural markers (`chatid not found`, `invalid userids`, `missing required field`) → fatal; format markers (`invalid markdown`, `unsupported format`, `character not allowed`) → fall back rich→plain once; an unmatched 400 defaults to format_rejected (conservative — try plain before giving up). See `src/send-retry.ts`.
