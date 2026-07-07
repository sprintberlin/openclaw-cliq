---
title: `.gitignore` ignores `*.js`
category: Build / TypeScript
source: migrated from AGENTS.md
---
- **`.gitignore` ignores `*.js`** (TS-sources-only policy). A `scripts/*.js` build smoke would be gitignored — use `.mjs` (gitignore `*.js` matches only names ending exactly in `.js`).
