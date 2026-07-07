---
title: Mention stripping
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **Mention stripping:** the core `stripMentions` helper (`mentions-B1EJNjZS.js:166`) calls the plugin's `mentions.stripRegexes(...)` then `mentions.stripMentions(...)`. Implementing `stripRegexes` is sufficient for the shared path; `stripMentions` is an optional override.
