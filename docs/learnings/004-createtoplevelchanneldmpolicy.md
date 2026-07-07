---
title: `createTopLevelChannelDmPolicy`
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **`createTopLevelChannelDmPolicy`** builds a `ChannelSetupDmPolicy` from `{ label, channel, policyKey, allowFromKey, getCurrent, promptAllowFrom?, getAllowFrom? }` — it constructs `setPolicy` internally from `policyKey`/`allowFromKey`, so you do NOT pass `setPolicy`. `getCurrent` must return one of `"pairing" | "allowlist" | "open" | "disabled"`. For single-account channels with config at the top level (`channels.<id>.dmPolicy`/`.allowFrom`), this is the right helper; `createNestedChannelDmPolicy` is for per-account sections under `channels.<id>.accounts.<acct>`.
