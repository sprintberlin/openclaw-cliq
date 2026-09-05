---
title: Deluge handlers must echo their eventId; a bare `{}` response hides the loss boundary
category: Zoho Cliq inbound / observability
files: [src/bot-provisioning.ts, src/handler-consistency.ts, src/inbound-outcome.ts, index.ts]
apis: [eventId, invokeUrl, /cliq/webhook]
issues: [#231, #232, #227]
---

Zoho's Bot execution log records every Message/Mention/Welcome handler run, but the generated script used to end with `response = Map(); return response;`. Every row therefore read `output: "{}"`. A successful POST, a rejected webhook, a transport failure and a handler that returned before `invokeUrl` were indistinguishable in the only log Zoho exposes.

The 2026-09-05 forward incident had four executions, two agent turns and two missing turns. The two missing ones were ~500–800 ms (a real dispatch is seconds) with `{}` output. Without a correlatable id that pattern is a diagnostic dead end: you cannot tell whether Deluge posted, the gateway skipped, or the POST never left.

The smallest safe fix is to echo the already-declared `eventId` into the response map. That reuses a symbol every handler already has, so it cannot trigger the permanent, non-retryable `execution_handler_update_failed` that the Mention Handler demonstrated with `attachments`. Capturing the `invokeUrl` HTTP status would be more diagnostic but requires a new Deluge construct; leave that to the verified schema rollout (#228). Never return the payload, the message text, the webhook secret or any token.

Doctor and the provisioning planner must treat a recognizable script that still returns a bare map as `stale_script`, same as a missing `eventId`. Existing installs need a confirmation-gated handler repair; `git pull` + restart alone does not update the Zoho-held copy.
