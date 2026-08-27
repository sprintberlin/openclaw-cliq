---
title: Plugin channel schemas must declare the same enablement key their setup writes
files: openclaw.plugin.json,src/channel.ts,src/setup-wizard.ts,src/client.ts
apis: config.isEnabled,plugins.entries.cliq.enabled,channels.cliq.enabled,setSetupChannelEnabled
---

A strict plugin channel schema (`additionalProperties: false`) must declare `enabled` when its setup flow writes `channels.<id>.enabled` or operators copying bundled-channel shapes will get a hard validation error from a config the plugin itself generates. Channel-level `enabled: false` should flow through `config.isEnabled` so OpenClaw skips account startup while preserving credentials; omission remains enabled for backward compatibility. `plugins.entries.<id>.enabled: false` is a separate, stronger core switch that prevents the plugin from loading at all, so channel-level `true` cannot override it.
