---
title: CLI commands that matter
category: Gateway smoke / real-loader verification
source: migrated from AGENTS.md
---
- **CLI commands that matter** (all headless, no running daemon needed): `openclaw --profile <p> plugins install --link .` links a local plugin dir on `2026.7.1-2`; on `>= 2026.8.1-beta.3` add `--force` to acknowledge that a local path is outside ClawHub trust metadata (the floor version rejects that combination). `plugins inspect <id> --json --runtime` loads the runtime for a registration test, `plugins list --json` supports `--enabled` / `--verbose`, and `plugins doctor` checks plugin installation health.
