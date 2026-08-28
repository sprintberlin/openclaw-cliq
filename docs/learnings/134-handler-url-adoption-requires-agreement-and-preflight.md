---
title: A missing publicWebhookUrl can be adopted only from agreed, preflighted handler URLs
files: src/handler-consistency.ts,src/doctor-runner.ts,src/inbound-verification-store.ts,src/doctor-command.ts
apis: channels.cliq.publicWebhookUrl,inboundVerifiedAt,openclaw cliq doctor --adopt-handler-url
---
The persistence guard for inbound verification refuses to record a result when `channels.cliq.publicWebhookUrl` is absent, even if a standalone preflight of the Zoho-held handler URL already passed. A candidate exists only when both Message and Mention handlers can be read, their secret fingerprints match the configured `webhookSecret`, and they agree on exactly one valid HTTPS `/cliq/webhook` URL — disagreement, an unrecognised script, or an invalid URL is never guessed. Default doctor remains read-only; writing that URL plus `inboundVerifiedAt` requires an explicit `--adopt-handler-url` (or equivalent consent) after a full authenticated preflight, and a failed, inconclusive, or foreign-secret run must leave config unchanged without mutating Zoho handlers.
