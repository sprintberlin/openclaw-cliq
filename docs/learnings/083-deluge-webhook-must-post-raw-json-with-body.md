---
title: Deluge webhook must POST raw JSON with `body: payload.toString()` + `Content-Type: application/json`
category: Zoho Cliq specifics
source: migrated from AGENTS.md
---
- **Deluge webhook must POST raw JSON with `body: payload.toString()` + `Content-Type: application/json`.** Using `parameters: payload.toString()` sends form-urlencoded and returns HTTP 400 (`readJsonBody` has a form-urlencoded tolerance fallback, but `body:` is the canonical shape).
