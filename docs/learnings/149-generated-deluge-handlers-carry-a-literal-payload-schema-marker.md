---
title: Generated Deluge handlers carry a literal payload-schema marker
category: Zoho Cliq inbound / provisioning
files: [src/handler-schema.ts, src/bot-provisioning.ts, src/handler-consistency.ts, src/inbound.ts, index.ts]
apis: [handlerSchema, payload.put, /api/v3/bots/{BOT_ID}/handlers/{TYPE}, /cliq/webhook]
issues: [#228]
---

A Zoho Bot handler is separately stored Deluge code, so installing a newer plugin or restarting the gateway cannot update the inbound payload contract that Zoho executes. Generated Message, Mention, and Welcome handlers therefore post the static literal `handlerSchema: "v2"`; Doctor/preflight and the confirmation-gated provisioning plan read that literal back and classify a missing or different marker as `stale_script`.

The `v2` marker adds no new Deluge variable or undocumented handler parameter: it is a direct `payload.put("handlerSchema", "v2")` literal alongside the verified existing fields. This is intentional because `execution_handler_update_failed` is a permanent script-validity error, not a retry signal; Message-only symbols such as `attachments` remain absent from the Mention handler. Runtime keeps accepting ordinary unversioned or unsupported-version text payloads, but emits one value-free warning per observed version until the Zoho-held script is repaired.
