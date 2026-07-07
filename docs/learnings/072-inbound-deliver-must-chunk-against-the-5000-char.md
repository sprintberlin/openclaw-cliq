---
title: Inbound `deliver` must chunk against the 5000-char cap
category: Zoho Cliq specifics
source: migrated from AGENTS.md
---
- **Inbound `deliver` must chunk against the 5000-char cap.** The buffered block dispatcher calls `deliver` once per coalesced block; when block streaming is OFF (default) it delivers the ENTIRE final agent reply as a single `deliver` call. A `deliver` that sends `payload.text` verbatim (one `sendMessage`) will be rejected by the Cliq API for any reply over 5000 chars. The deliver callback (live-edit or legacy) must `chunkMessage` the rich text before sending.
