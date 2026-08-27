---
title: A probe that authenticates with its own config cannot prove what the sender holds
files: src/webhook-preflight.ts,src/handler-consistency.ts,src/client.ts
apis: /api/v3/bots/{BOT_ID}/handlers/{TYPE},ZohoCliq.Bots.READ,x-cliq-webhook-secret
---

A diagnostic that reads a shared secret from local config and presents it to its own endpoint only proves the config is internally consistent; it is blind to the copy the real sender holds (for Cliq, the `webhookSecret` literal hardcoded in the bot's Deluge handler). When those diverge, every real delivery is rejected with `401` while all self-authenticated stages report green, so the sender-side value must be fetched independently — `GET /api/v3/bots/<botId>/handlers/<type>` returns it on `data.script` under `ZohoCliq.Bots.READ`. Compare short SHA-256 fingerprints rather than values, since the script body is itself a live credential that must not reach logs or reports. Any inability to look (missing scope, absent bot id, unrecognised script shape) must degrade to an explicit `skipped`, because reporting `pass` for "we could not check" recreates exactly the false assurance being fixed.
