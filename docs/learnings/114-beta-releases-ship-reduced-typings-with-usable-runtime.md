---
title: OpenClaw beta floors can require moving imports to stable public SDK surfaces
files: .github/openclaw-compat.json,.github/workflows/compat.yml,src/activity.ts,src/config-validation.ts
apis: openclaw/plugin-sdk/channel-core,openclaw/plugin-sdk/channel-contract,openclaw/plugin-sdk/channel-config-schema,openclaw/plugin-sdk/infra-runtime
---

When a beta removes declarations or export entries for aggregate SDK modules, derive adapter types from `ChannelPlugin` and import shared contexts from stable public surfaces such as `channel-contract`, `core`, and `tool-results` instead of abandoning typechecking. Pin that beta as the typecheck/build floor, then runtime-verify the identical artifact on every supported OpenClaw version; test-only helpers that disappear from the floor should be replaced with isolated account ids or before/after assertions.
