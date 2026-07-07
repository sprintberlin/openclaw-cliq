---
title: Cliq Welcome Handler is a separate bot handler with its OWN scope attribute
category: Zoho Cliq specifics
apis: [ZohoCliq.Webhooks.CREATE]
source: migrated from AGENTS.md
---
- **Cliq Welcome Handler is a separate bot handler with its OWN scope attribute.** The Welcome Handler fires on subscribe / re-subscribe and the Deluge editor exposes a `newuser` boolean (true = first subscription, false = returning) plus the `user` object in the handler scope — there is NO `message` object (a welcome event carries no body text). The Deluge handler forwards the event to the webhook with `handler: "welcome"` (or `"subscribe"`) and `newuser`. Because the welcome event has no message body, the regular `parseCliqWebhookPayload` (which requires text or an attachment) rejects it — welcome must be detected and routed BEFORE the message parser. The greeting DM uses the same `ZohoCliq.Webhooks.CREATE` scope + `client_credentials` grant as any bot DM, so NO new OAuth scope or `refreshToken` is required for the welcome path (unlike channel posts / edits / reactions, which need the user-context grant). The `newuser` attribute defaults to `true` when absent (the conservative read: a welcome with no `newuser` is treated as a first-time subscription).
