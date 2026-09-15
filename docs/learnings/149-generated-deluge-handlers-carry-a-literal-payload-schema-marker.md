---
title: Generated Deluge handlers carry a literal payload-schema marker
category: Zoho Cliq inbound / provisioning
files: [src/handler-schema.ts, src/bot-provisioning.ts, src/handler-consistency.ts, src/inbound.ts, index.ts]
apis: [handlerSchema, payload.put, /api/v3/bots/{BOT_ID}/handlers/{TYPE}, /cliq/webhook]
issues: [#228]
---

A Zoho Bot handler is separately stored Deluge code, so installing a newer plugin or restarting the gateway cannot update the inbound payload contract that Zoho executes. Generated Message, Mention, and Welcome handlers therefore post a static `handlerSchema` literal; Doctor/preflight and the confirmation-gated provisioning plan read that literal back and classify a missing or different marker as `stale_script`. Version `v2` added the marker; `v3` adds multipart FILE forwarding for Message-handler attachments.

The marker itself adds no undocumented handler parameter: it is a direct `payload.put("handlerSchema", "vN")` literal. Message-only symbols such as `attachments` remain absent from the Mention handler because `execution_handler_update_failed` is a permanent script-validity error, not a retry signal. Runtime keeps accepting ordinary unversioned or unsupported-version text payloads, but emits one value-free warning per observed version until the Zoho-held script is repaired.
