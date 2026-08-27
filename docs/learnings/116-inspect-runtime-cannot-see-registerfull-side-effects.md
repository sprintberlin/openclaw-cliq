---
title: "`plugins inspect --runtime` cannot see anything registered in `registerFull` (httpRoutes is always 0)"
files: index.ts, src/webhook-route-check.ts, scripts/smoke-gateway.sh
apis: registerHttpRoute, registerSecurityAuditCollector, registerFull, registrationMode, httpRoutes
---

`openclaw plugins inspect <id> --runtime --json` loads plugins with
`activate: false`, which makes the loader choose `registrationMode:
"discovery"`; `defineChannelPluginEntry` returns after `registerCliMetadata`
and never calls `registerFull`, so everything registered there
(`api.registerHttpRoute`, `api.registerSecurityAuditCollector`) is missing
from the reported registry — `"httpRoutes": 0` on a healthy install whose
route answers `GET`→`405` at that moment, configured or not. `channelIds` and
`cliCommands` populate from the manifest snapshot and `registerCliMetadata`,
which is what makes the zero look credible.

Manifest `contracts` cannot fix it (it declares no HTTP routes) and moving
registration out of `registerFull` would bind a live webhook during
non-activating diagnostic loads. Verified against openclaw@2026.7.1-2;
reported upstream as openclaw/openclaw#130773. Prove route registration by
querying the running gateway instead (`openclaw cliq webhook-route`); when
capturing a plugin CLI command in shell, capture stderr because the OpenClaw
CLI redirects plugin-command `console.log` output there.
