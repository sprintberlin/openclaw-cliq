---
title: Version-dependent OpenClaw SDK exports must use dynamic namespace access
files: src/sdk-compat.ts,src/pairing.ts,src/secret-contract.ts,src/gateway.ts
apis: openclaw/plugin-sdk/conversation-runtime,openclaw/plugin-sdk/channel-secret-basic-runtime,openclaw/plugin-sdk/gateway-runtime,approveChannelPairingCode,channelReadyPatch
---

Static named ESM imports are validated before plugin code runs, so withdrawing one SDK export can prevent the entire channel from loading. For an SDK value that is not exported by every supported OpenClaw version, resolve it with cached dynamic `import()` namespace-property access, validate its shape, and degrade explicitly when absent; use a shared stable subpath directly when only the module path moved.
