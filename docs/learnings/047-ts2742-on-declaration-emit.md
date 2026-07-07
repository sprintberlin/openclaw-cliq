---
title: TS2742 on declaration emit
category: Build / TypeScript
files: [index.ts]
source: migrated from AGENTS.md
---
- **TS2742 on declaration emit:** `defineChannelPluginEntry` returns `DefinedChannelPluginEntry<TPlugin>`, whose member types come from internal SDK modules that cannot be named portably; emitting a `.d.ts` for `index.ts`'s default export triggers `TS2742`. The type is not re-exported from any public SDK entry, so there is nothing portable to annotate with. Fix: `declaration:false` in `tsconfig.build.json`. Safe, because the gateway loads plugins via the `openclaw.extensions` manifest field (`./index.ts`, resolved with tsx) — never via `main`/`types`, so no `.d.ts` is consumed. Source maps are still emitted.
