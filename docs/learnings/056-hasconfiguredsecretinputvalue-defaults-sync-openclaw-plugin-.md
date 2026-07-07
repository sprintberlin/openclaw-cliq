---
title: `hasConfiguredSecretInput(value, defaults?)` (sync, `openclaw/plugin-sdk/secret-input-runtime`) is the right presence check for a secret field
category: Secrets (`openclaw secrets audit/apply/reload`)
source: migrated from AGENTS.md
---
- **`hasConfiguredSecretInput(value, defaults?)` (sync, `openclaw/plugin-sdk/secret-input-runtime`) is the right presence check for a secret field** — returns true for both plaintext and any SecretRef shape. Use it in `inspectAccount` / setup-wizard `isConfigured` so a SecretRef-configured `clientSecret` is reported as present (not re-prompted / not flagged missing) after `openclaw secrets apply` rewrites it. A bare truthiness check (`Boolean(section.clientSecret)`) happens to work for presence (a SecretRef object is truthy) but `hasConfiguredSecretInput` is the semantically correct, future-proof check.
