---
title: CLI commands that matter
category: Gateway smoke / real-loader verification
source: migrated from AGENTS.md
---
- **CLI commands that matter** (all headless, no running daemon needed): `openclaw --profile <p> plugins install . --link` (links a local plugin dir; `--force` is rejected with `--link`), `plugins inspect <id> --json --runtime` (loads the runtime — the real registration test), `plugins list --json` (`--enabled`/`--verbose`), `plugins doctor`.
