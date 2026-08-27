---
title: "`openclaw security audit` runs channel `security.collectAuditFindings` by default — `registerFull` collectors are invisible even with `--deep`"
files: src/channel.ts, src/security-audit.ts, scripts/smoke-gateway.sh
apis: collectAuditFindings, registerSecurityAuditCollector, collectPluginSecurityAuditFindings, loadPluginSecurityCollectors, createChatChannelPlugin
---

`openclaw security audit` has TWO distinct plugin-finding sweeps (verified
against openclaw@2026.7.1-2, `dist/audit-UjVvFwCi.js`):

1. **Channel security sweep (default, always on).** For every configured
   channel plugin it resolves each account, then calls the plugin's channel
   security adapter hooks — `resolveDmPolicy` (generic `channels.<id>.dm.*`
   findings), `collectWarnings`, and **`collectAuditFindings`** (structured
   `SecurityAuditFindings`, checkId convention `channels.<id>.*`). This sweep
   loads channel plugins read-only via `inspectAccount` / `resolveAccount`,
   no activation required — so it sees the plugin WITHOUT `registerFull`
   ever running, and it is NOT gated behind `--deep`.

2. **Plugin-collector sweep (`--deep` only).**
   `collectPluginSecurityAuditFindings` starts with
   `if (!context.loadPluginSecurityCollectors) return []` and the flag is
   wired as `opts.loadPluginSecurityCollectors ?? deep`. When no ACTIVE
   gateway registry is in-process (the CLI case), it falls back to
   `loadPluginMetadataRegistrySnapshot`, which loads plugins with
   `activate: false` → `registrationMode: "discovery"` → `registerFull`
   never runs → `api.registerSecurityAuditCollector(fn)` registrations are
   structurally absent (same mechanism as the `httpRoutes: 0` bug in
   learning 116 / openclaw/openclaw#130773).

Consequence for issue #111: a plugin channel that ONLY registers a collector
in `registerFull` contributes NOTHING to `openclaw security audit`, default
or `--deep`. The fix is to wire the same pure collector into
`createChatChannelPlugin`'s `security.collectAuditFindings` (ctx:
`{ cfg, accountId, account, sourceConfig, orderedAccountIds,
hasExplicitAccountPath }`). Findings are deduped by full content, so the two
surfaces can overlap safely when both ever run.

E2E proof belongs in the gateway smoke (`run_oc security audit --json`,
assert `channels.cliq.secrets.plaintext` in `findings`) — the shipped CLI's
audit output is the acceptance surface; calling the collector function
directly proves only the logic, not the delivery.
