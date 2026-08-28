---
title: `$NAME` / `${NAME}` env shorthands must be coerced before `resolveSecretInputString`
files: src/secret-resolve.ts,src/security-audit.ts
apis: coerceSecretRef,resolveSecretInputString,openclaw/plugin-sdk/secret-input-runtime
---
- **`resolveSecretInputString` treats `$NAME` / `${NAME}` as available plaintext.** On the current SDK (`openclaw/plugin-sdk/secret-input-runtime`, openclaw@2026.8.1-beta.3) `coerceSecretRef("$CLIQ_WEBHOOK_SECRET")` returns a structured env SecretRef, but `resolveSecretInputString` on the same string returns `{status:"available",value:"$CLIQ_WEBHOOK_SECRET",ref:null}`. A plugin that feeds the raw config string into the resolver will use the placeholder as the OAuth, webhook, or refresh secret. Canonicalize with `coerceSecretRef(value, secrets.defaults)` first so runtime resolution, doctor inspection, and `openclaw security audit` share one classification.
