---
title: `resolveInboundMentionDecision`
category: OpenClaw Plugin SDK
source: migrated from AGENTS.md
---
- **`resolveInboundMentionDecision`** accepts a flat params object or a nested `{ facts, policy }`; the nested form is preferred. For DMs force `wasMentioned: true`; for groups require an explicit mention.
