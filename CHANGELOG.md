# Changelog

All notable changes to `@sprintcx/openclaw-cliq` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a `## [X.Y.Z] - YYYY-MM-DD` heading; the ClawHub
publish workflow extracts the matching section as the release notes (see
[RELEASING.md](RELEASING.md)).

## [Unreleased]

### Changed

- Documented multi-data-center support: the setup guide now uses `.com` (US)
  example URLs with a "pick your data center" callout and anchor, and a new
  **Data centers** section maps every Zoho region to its `oauthBase` / `apiBase`.
  Corrected the outdated "hard-coded EU / file an issue" note — the `oauthBase`
  and `apiBase` config fields (default EU) already select the region. Added
  wizard labels for both fields.

## [0.1.1] - 2026-07-06

### Added

- Product-first README landing: Zoho Cliq logo hero, a 4-step Quick start, and a
  scannable feature/capability table.
- `CI` workflow (`typecheck` · `test` · `build`) on every push and pull request.
- `Publish ClawHub` workflow — publishes to ClawHub on a stable `vX.Y.Z` tag
  push (dry-run on manual dispatch), with a strict `package.json`↔tag version
  check and a GitHub Release carrying the CHANGELOG section as notes.
- Contributor docs: `CONTRIBUTING.md`, `RELEASING.md`, `SECURITY.md`, GitHub
  issue forms, and a pull-request template.

### Changed

- Unified the plugin summary across `package.json`, `openclaw.plugin.json`, and
  `index.ts`.

## [0.1.0] - 2026-07-06

### Added

- Initial public release of the Zoho Cliq channel plugin for OpenClaw.
- Inbound DMs and channel @mentions via a Deluge webhook (`POST /cliq/webhook`);
  outbound as the bot (DMs via `userids`, channel posts via `channelsbyname`).
- OAuth 2.0 dual-grant: `client_credentials` for DMs, a user-context refresh
  token for channel posts and message edits (EU endpoints).
- Rich messaging: Markdown → Cliq formatting, live-edit streaming previews,
  interactive buttons & cards, slash-style commands, reply threading.
- Message actions: edit / delete / react.
- DM security policies (`allowlist` / `pairing` / `open` / `disabled`) with an
  approval flow, plus group admission and per-channel mention & tool policy.
- Reliability: durable-before-ack ingest, de-dup on redelivery, bot-loop /
  self-message protection, outbound retry with error classification, hardened
  webhook auth (constant-time secret compare, failed-auth rate limiting).
- Operations: `openclaw status` / `channels` health probe, `openclaw directory`
  lookup, plugin doctor, interactive setup wizard, SecretRef-backed credentials,
  security audit collector, session binding, multi-account, lifecycle hooks.

[Unreleased]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sprintberlin/openclaw-cliq/releases/tag/v0.1.0
