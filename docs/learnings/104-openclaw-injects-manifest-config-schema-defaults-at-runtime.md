---
title: OpenClaw injects manifest config-schema `default` values at runtime — a manifest default overrides code defaults
files: openclaw.plugin.json,src/client.ts,src/account-inspect.ts
apis: apiVersion,configSchema,channelConfigs
---

OpenClaw applies a manifest's `configSchema` / `channelConfigs.*.schema` `default` values at **runtime**, injecting them into the resolved config handed to the plugin — even when the operator set nothing. So a manifest `"default": "v2"` on a field that the plugin code also defaults (via its own `normalize`/`resolve` function) silently wins: the code's default never runs because the field arrives already-set from the runtime. This bit `apiVersion` in issue #86: the code added a per-family default (`dmPost: "v3"`) in `resolveCliqConfig`, but the manifest still declared `"default": "v2"`, so the runtime injected `apiVersion: "v2"` and the code read it as a global `"v2"` override — the whole v3-DM feature was dead unless the operator manually set `apiVersion: "v3"`.

The fix: when a field's default is owned by the **code** (computed per-family, conditional, or "unset → built-in default"), the manifest schema must declare **no `default`** (leave the key out entirely — `undefined`, not a sentinel string). The schema should accept the full shape the code handles (e.g. `oneOf: [string, per-family-object]`), and a test must assert that an **omitted** field resolves through the **full config-resolution path the runtime uses** (the manifest-schema-defaulted config, not just the raw `resolve*` unit) — the bug was that those two diverged.

There is a second edge case for nested objects: defaults on child properties do not guarantee that OpenClaw creates an omitted parent object. A schema default on `thinking.mode` is therefore not enough when the operator omits `thinking` entirely. The plugin's resolver must also apply the documented defaults to `section?.thinking === undefined`, and the regression test must pass a config with the whole parent object absent. A test that constructs `thinking` from the schema defaults only proves the child-property case and misses the real existing-config path.
