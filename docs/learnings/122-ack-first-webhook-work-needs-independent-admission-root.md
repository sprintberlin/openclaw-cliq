---
title: Ack-first webhook work needs an independent admission root on OpenClaw 2026.8.x
files: [index.ts, src/sdk-compat.ts, src/detached-dispatch.ts]
apis: [openclaw/plugin-sdk/webhook-request-guards, runDetachedWebhookWork, GatewayDrainingError]
issues: [#122]
---

On OpenClaw `>= 2026.8.1-beta.3`, an ack-first webhook continuation outlives the HTTP request admission it inherited; once that admission is released, queue enqueues from the inherited chain are rejected with `GatewayDrainingError` even when the gateway is healthy. Call `runDetachedWebhookWork` synchronously while the request is still admitted and before writing the response, but resolve it with dynamic namespace access because `2026.7.1-2` does not export the symbol and should retain its working fire-and-forget path.
