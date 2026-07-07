---
title: The gateway does NOT auto-resolve registered channel secret paths before handing config to a plugin channel
category: Secrets (`openclaw secrets audit/apply/reload`)
source: migrated from AGENTS.md
---
- **The gateway does NOT auto-resolve registered channel secret paths before handing config to a plugin channel.** `resolveConfiguredSecretInputString` (async, `openclaw/plugin-sdk/secret-input-runtime`) is only called by providers/matrix-auth in the gateway core — NOT by the channel dispatch path. So a plugin channel whose `resolveAccount` reads `section.clientSecret` directly would read a SecretRef *object* after `openclaw secrets apply` rewrites it, breaking the OAuth call (`client_secret=[object Object]`). The channel MUST resolve SecretRef → plaintext itself at read time.
