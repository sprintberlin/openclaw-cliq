---
title: The SDK's channel/plugin test-contract helpers are NOT published for third-party plugins
category: Plugin-channel test contract
files: [src/test-api.ts]
source: migrated from AGENTS.md
---
- **The SDK's channel/plugin test-contract helpers are NOT published for third-party plugins.** `https://docs.openclaw.ai/plugins/sdk-testing` lists `createTestPluginApi` (`plugin-sdk/plugin-test-api`), `createMockIncomingRequest`/`createMockServerResponse`/`withServer` (`plugin-sdk/test-env`), `expectChannelInboundContextContract`/`installChannelOutboundPayloadContractSuite` (`plugin-sdk/channel-contract-testing`), `createStartAccountContext`/`installChannel*ContractSuite` (`plugin-sdk/channel-test-helpers`), `describePluginRegistrationContract` (`plugin-sdk/plugin-test-contracts`), `registerSingleProviderPlugin`/`createPluginRuntimeMock` (`plugin-sdk/plugin-test-runtime`), etc. — but the docs themselves state these are "repo-local source entrypoints for OpenClaw's own bundled plugin tests. They are not published `package.json` exports for third-party plugins, and they may import Vitest or other repo-only test dependencies." Inspecting the installed `node_modules/openclaw/package.json` `exports` confirms this: only `channel-feedback` (ack/status-reaction runtime helpers, not test fixtures) is published among the "test" subpaths. So an external plugin channel *cannot* literally "exercise the channel the same way bundled channels are" via the SDK contract suites — the closest achievable is a repo-local shared test harness that consolidates the duplicated mock shapes (`cfgWith`, `makeRes`, `makeReq`, `buildMockApi`) into one `src/test-api.ts` module imported across `*.test.ts` files. Such a test-only helper module MUST be excluded from the published `dist/` build: add `src/test-api.ts` to `tsconfig.build.json`'s `exclude` (alongside `src/**/*.test.ts`), since the build's `include` of `src/**/*.ts` would otherwise emit it to `dist/` and ship a test-only module to consumers. The repo-local `src/test-api.ts` mirrors the shapes of the SDK's unpublished `plugin-test-api` (`createTestPluginApi`) and `test-env` (`createMockIncomingRequest`/`createMockServerResponse`) helpers so a future SDK publication is a near drop-in.

## Target audience

This plugin will be used by:
1. **SprintCX internal agents** (Zora on Smart Bridges server, etc.)
2. **External OpenClaw users** who want Zoho Cliq as a channel
3. **ClawHub users** discovering the plugin via search

The plugin must be self-contained, well-documented, and easy to configure via `openclaw.json`.
