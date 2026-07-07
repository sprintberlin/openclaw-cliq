---
title: Programmatic webhook registration is NOT possible for Zoho Cliq
category: Webhook security
source: migrated from AGENTS.md
---
- **Programmatic webhook registration is NOT possible for Zoho Cliq.** Unlike Telegram's `setWebhook` REST endpoint, Cliq inbound message delivery is wired via a Deluge script in the Cliq bot handler (configured in the Zoho Cliq bot builder UI) that calls `invokeUrl` to POST to our endpoint — there is no REST API to register/unregister a webhook URL. So "register webhook on start, clean up on stop" is not achievable for Cliq; the Deluge wiring is inherently a manual step. `runStartupMaintenance` mitigates this by logging the exact path + required header at gateway start so the operator has a copy-paste-ready target.
