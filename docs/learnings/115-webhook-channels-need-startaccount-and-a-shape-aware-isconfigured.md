---
title: Webhook channels need startAccount plus a shape-aware isConfigured
files: src/gateway.ts,src/channel.ts,src/account-inspect.ts,src/status.ts,src/activity.ts,src/sdk-compat.ts
apis: gateway.startAccount,config.isConfigured,config.describeAccount,channelReadyPatch,recordChannelActivity,openclaw/plugin-sdk/gateway-runtime,openclaw/plugin-sdk/infra-runtime
---

OpenClaw only marks a channel `running` when `gateway.startAccount` stays pending; returning immediately (or omitting the hook) leaves `running: false`, which the health policy maps to `not-running` and restarts. Newer gateways additionally set `lifecycle: "starting"` until the channel publishes a ready patch (`channelReadyPatch` on `openclaw/plugin-sdk/gateway-runtime`, absent on `2026.7.x` so it must be resolved dynamically). Separately, `config.isConfigured` is called with the *resolved* account on the Channels path and the *redacted inspectAccount* shape on the Health path — a predicate that requires `clientSecret` therefore reports a healthy account as unconfigured on Health only. `lastInboundAt` / `lastOutboundAt` stay `null` unless the channel calls `recordChannelActivity`.
