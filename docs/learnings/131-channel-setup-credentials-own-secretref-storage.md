---
title: Channel setup `credentials` is how OpenClaw stores SecretRefs; a custom `finalize` prompt still writes literals
category: Setup
files: src/setup-wizard.ts,src/setup-report.ts
apis: ChannelSetupWizard.credentials,runSingleChannelSecretStep,promptSecretRefForSetup,finalize
---
- **OpenClaw's channel setup writes SecretRefs only through `wizard.credentials`.** Each credential step can offer env interpolation or `promptSecretRefForSetup`; `finalize` then receives `credentialValues` and a config that already holds those refs. A plugin that leaves `credentials: []` and collects secrets itself in `finalize` still receives whatever the operator typed as a literal string, so that path must rewrite new literals into canonical env-backed SecretRefs before returning config, while preserving existing refs and `$ENV` interpolation on rerun. The wizard cannot silently overwrite a global secret representation without operator consent, and the generated config must be validated after that rewrite.
