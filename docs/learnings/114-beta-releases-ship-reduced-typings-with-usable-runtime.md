---
title: Beta OpenClaw releases ship a reduced .d.ts surface while the runtime JS stays usable
files: .github/openclaw-compat.json,.github/workflows/compat.yml,scripts/check-sdk-compat.mjs
apis: openclaw/plugin-sdk/channel-runtime,openclaw/plugin-sdk/agent-core,openclaw/plugin-sdk/channel-mention-gating
---

A beta release can drop `.d.ts` files (and whole `exports` entries) for modules whose runtime JavaScript a plugin still loads fine, so typechecking against the beta would force deleting real type-only imports for no runtime benefit. Typecheck and build against the pinned floor version, then runtime-verify that identical artifact on every supported version with the gateway smoke. Published tarballs cannot be imported to enumerate exports because their transitive dependencies are absent, so parse each module's static `export { … }` list instead.
