# Changelog

All notable changes to `@sprintcx/openclaw-cliq` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a `## [X.Y.Z] - YYYY-MM-DD` heading; the ClawHub
publish workflow extracts the matching section as the release notes (see
[RELEASING.md](RELEASING.md)).

## [Unreleased]

### Added

- Inbound media attachments (issue #48): images, files, and voice messages a user
  sends are downloaded via the Cliq Files API (`GET /api/v2/files/{id}`, new scope
  `ZohoCliq.Attachments.READ`) and handed to the agent as local media; voice is
  left for the runtime media-understanding pipeline to transcribe. A failed
  download degrades to "no media" for that attachment and never breaks the turn.
  DM-only setups without a `refreshToken` simply skip inbound media.
- Instant acknowledgement / "thinking" placeholder (issue #47): Zoho Cliq
  exposes no bot "typing" REST API, so the bot's progress is invisible until
  the final reply lands (the native "processing" hint is easy to miss). A new
  `thinking` config (`{ mode: "off" | "placeholder", text }`, default `"off"`,
  schema-validated in both the top-level and `channelConfigs.cliq` schemas with
  `uiHints`) opts the channel into posting a lightweight placeholder message
  (default `💭 …`) the moment an inbound message is accepted, then editing it
  in place into the final agent reply — exactly one message, no duplicate. The
  feature is a no-op when `streaming.preview` is on (the live-edit path already
  shows progress) or when no `refreshToken` is configured (editing a message
  needs the user-context token). A failed placeholder post or edit is
  swallowed + logged and never breaks or delays the agent turn; when the
  placeholder cannot be cleanly turned into the reply it is deleted so no
  stray `💭 …` lingers. DMs and channel posts both support it.

## [0.1.2] - 2026-07-06

### Added

- Multi-data-center auto-detection so non-EU Zoho installs work out of the box
  (issue #46):
  - The setup wizard prompts for your Zoho data center (region) first and
    writes `oauthBase` + `apiBase` together from a region→endpoints map (EU
    default; existing region reused on re-run). The printed API Console URL
    matches the chosen region (no more hard-coded `api-console.zoho.eu`).
  - After the first OAuth token exchange, the plugin reads the `api_domain`
    Zoho returns in the token response and self-corrects `apiBase` to the
    matching `cliq.zoho.<tld>` when it disagrees with the configured region
    (the raw `zohoapis` host is mapped back to the Cliq host, never used
    directly); `oauthBase` is left unchanged. Applies to both the
    `client_credentials` and `refresh_token` grants.
  - `openclaw doctor` warns when only one of `oauthBase` / `apiBase` is set, or
    when the two point at different regions.
  - Zoho auth failures (`invalid_client` / `oauthtoken_scope_invalid` / 4xx
    auth) now surface a `verify your Zoho data center` hint on the thrown
    error for both the OAuth token path and the outbound send path.
- Setup guide screenshots: navigating to **Bots & Tools** (profile → My Cliq),
  and the **Edit Handlers** page (where the Deluge script goes into Message
  Handler / Mention Handler).

### Fixed

- Corrected the bot-creation navigation: bots live under **profile picture → My
  Cliq → Bots & Tools**, not a left-sidebar "Bots" entry.

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

[Unreleased]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sprintberlin/openclaw-cliq/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sprintberlin/openclaw-cliq/releases/tag/v0.1.0
