---
title: The plugin loads on a real gateway (verified against openclaw@2026.6.11)
category: Gateway smoke / real-loader verification
files: [index.ts]
source: migrated from AGENTS.md
---
- **The plugin loads on a real gateway (verified against openclaw@2026.6.11).** `plugins inspect cliq --json --runtime` reports `status: "loaded"`, `shape: "plain-capability"`, and a `capabilities: [{ kind: "channel", channelIds: [...] }]` entry; `plugins doctor` reports "No plugin issues detected". The loader resolves the entry from `package.json` `main` → `dist/index.js` (NOT the manifest `openclaw.extensions` `./index.ts`), so **`dist/` must be built before install** — the smoke builds first.
