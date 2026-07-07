---
title: `ChannelSetupInput` has a FIXED key set
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **`ChannelSetupInput` has a FIXED key set** (`token`, `secret`, `botToken`, `appToken`, `userId`, `url`, `webhookPath`, `cliPath`, … — see `types.core-DF7IXShG.d.ts:134`); there is no index signature, so a credential's `inputKey: keyof ChannelSetupInput` cannot be a channel-specific name like `clientId`. Channels with custom/extra credentials sidestep this by setting `credentials: []` and doing all prompting in `finalize` (the MS Teams pattern in `setup-surface-DP-Q3K7p.js`): `finalize({ cfg, prompter, ... })` shows an intro `note`, calls `prompter.text`/`confirm` for each field (with keep-existing + env-var-shortcut logic), patches `channels.<id>` directly, and returns `{ cfg, accountId }`. This keeps the declarative `status`/`dmPolicy`/`disable` sections while owning credential collection imperatively. `prompter.text({ message, placeholder, initialValue?, validate?, sensitive? })` returns `Promise<string>`; `prompter.confirm({ message, initialValue? })` returns `Promise<boolean>`; `prompter.note(message, title?)` returns `Promise<void>`.
