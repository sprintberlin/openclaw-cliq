---
title: Setup wizard (`setupWizard` adapter)
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **Setup wizard (`setupWizard` adapter).** Lives on `ChannelPlugin` and is forwarded by `createChatChannelPlugin` (it picks up `setupWizard` from `base` via `CreatedChannelPluginBase`'s `Partial<Pick<…,"setupWizard"…>>`). The field accepts either a declarative `ChannelSetupWizard` or an imperative `ChannelSetupWizardAdapter`; the declarative form is consumed by the generic setup adapter and is far less code. Import surface is `openclaw/plugin-sdk/setup`, which re-exports everything needed: `createStandardChannelSetupStatus`, `createTopLevelChannelDmPolicy`/`createNestedChannelDmPolicy`, `createAccountScopedAllowFromSection`, `createAccountScopedGroupAccessSection`, `setSetupChannelEnabled`, `patchChannelConfigForAccount`, `parseMentionOrPrefixedId`, `mergeAllowFromEntries`, `splitSetupEntries`, `resolveEntriesWithOptionalToken`, `DEFAULT_ACCOUNT_ID`, plus the `ChannelSetupWizard`/`ChannelSetupDmPolicy`/`WizardPrompter`/`OpenClawConfig` types. `ChannelSetupWizardFinalize` is NOT exported — type the finalize hook as `NonNullable<ChannelSetupWizard["finalize"]>`.
