---
title: `pairing` option
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **`pairing` option** accepts a raw `ChannelPairingAdapter` or `{ text: { idLabel, message, normalizeAllowEntry?, notify } }`; the latter is converted via `createInlineTextPairingAdapter` (`core-D-xoNfL6.js:227`), so the resolved `plugin.pairing` exposes `idLabel`/`message`/`notify` directly (NOT under `text`).
