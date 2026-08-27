---
title: "`plugins inspect --runtime` cannot see anything registered in `registerFull` (httpRoutes is always 0)"
files: index.ts, src/webhook-route-check.ts, scripts/smoke-gateway.sh
apis: registerHttpRoute, registerSecurityAuditCollector, registerFull, registrationMode, httpRoutes
---

`openclaw plugins inspect <id> --runtime --json` loads plugins with
`activate: false`, which makes the loader choose `registrationMode:
"discovery"`; `defineChannelPluginEntry` returns after `registerCliMetadata`
in that mode and never calls `registerFull`. Everything registered there —
`api.registerHttpRoute`, `api.registerSecurityAuditCollector` — is therefore
absent from the throwaway registry the command reports, so a healthy install
shows `"httpRoutes": 0` and no security-audit collectors while the gateway
process serves `GET /cliq/webhook` → `405` and `POST` → `401` at that same
moment. `channelIds` and `cliCommands` populate because they come from the
manifest snapshot and from `registerCliMetadata`, which do run in discovery
mode — the payload looks partially correct, which is what makes the zero
convincing.

Manifest `contracts` cannot fix the count (it declares no HTTP routes; the
counter only increments when `registerHttpRoute` actually executes), and
moving registration out of `registerFull` is wrong — a non-activating
diagnostic load must not bind a live inbound webhook. Verified against
openclaw@2026.7.1-2 on a configured profile; reported upstream as
openclaw/openclaw#130773. The trustworthy check is to ask the running gateway
instead: `openclaw cliq webhook-route` (`src/webhook-route-check.ts`) reads
`405` as registered and `404` as absent, and treats an unreachable gateway as
`unknown` rather than as a missing route.
