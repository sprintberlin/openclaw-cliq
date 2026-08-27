---
title: An unprobeable OAuth capability is not a probe error and granted scope text is not proof
files: [src/capabilities.ts, src/doctor-runner.ts, src/setup-provisioning.ts]
apis: [ZohoCliq.Bots.READ, ZohoCliq.Bots.CREATE, ZohoCliq.Bots.UPDATE, oauthtoken_scope_invalid]
issues: [#93, #110]
---

A safe diagnostic must distinguish **proven** (a non-destructive API call succeeded), **unprobeable** (the only proof would send, update, delete, or create live state), **scope-reported-only** (the grant response names the scope), and **probe error** (a safe probe ran but was inconclusive). Zoho can issue a token that reports a scope and still reject the operation with `oauthtoken_scope_invalid`, so granted scope text is useful only as a one-directional fail-closed gate: a known-missing scope blocks, but a present scope never authorises a mutation without the real API result.
