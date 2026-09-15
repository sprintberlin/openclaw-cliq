---
title: Deluge webhook must POST the payload Map with `body: payload` + `Content-Type: application/json`
category: Zoho Cliq specifics
source: migrated from AGENTS.md
files: [src/bot-provisioning.ts, src/inbound-webhook-body.ts, README.md]
apis: [invokeUrl, body, payload, Content-Type]
issues: [#259]
---
- **Deluge webhook must POST the payload Map with `body: payload` + `Content-Type: application/json`.** Passing the Map itself lets Zoho own JSON serialization and escaping. `payload.toString()` emits JSON-looking text that does not escape nested string values, so quotes, newlines, and CRM unfurl/card fields in native `user`/`chat` objects produce unparseable bodies. `parameters:` form-encodes the payload and is invalid for this webhook. Live proof (2026-09-15): a previously rejected CRM-unfurl DM reached `/cliq/webhook` as a dispatched agent turn after the generated handler switched to `body: payload`. The Message Handler multipart `stringPart` still uses `payload.toString()` until that branch is proven separately.
