---
title: Every denied request carries `Connection: close`
category: Webhook security
source: migrated from AGENTS.md
---
- **Every denied request carries `Connection: close`.** This tears down the keep-alive socket after the response so a denied attacker cannot reuse the connection for rapid retries. Set the header on both 401 and 429 paths.
