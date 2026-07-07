---
title: `openclaw` is BOTH a `peerDependency` (runtime: the gateway provides it) AND a `devDependency` (so `npm ci` installs the CLI + SDK types for typecheck/tests/smoke)
category: Gateway smoke / real-loader verification
source: migrated from AGENTS.md
---
- **`openclaw` is BOTH a `peerDependency` (runtime: the gateway provides it) AND a `devDependency` (so `npm ci` installs the CLI + SDK types for typecheck/tests/smoke).** A root package's `peerDependencies` are NOT auto-installed by npm; relying on the lockfile alone is fragile. The devDependency guarantees `node_modules/.bin/openclaw` exists for the smoke.
