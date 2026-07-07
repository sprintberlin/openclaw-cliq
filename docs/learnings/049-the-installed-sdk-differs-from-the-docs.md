---
title: The installed SDK differs from the docs
category: Build / TypeScript
source: migrated from AGENTS.md
---
- **The installed SDK differs from the docs:** `resolveAccount`/`inspectAccount` live on `config: ChannelConfigAdapter`, NOT on `setup` (which holds `applyAccountConfig`). The docs example is outdated relative to the installed version.
