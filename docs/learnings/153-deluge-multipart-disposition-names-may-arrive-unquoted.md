---
title: Deluge multipart disposition names may arrive unquoted
files: [src/inbound-webhook-body.ts]
apis: [invokeUrl, files, Content-Disposition, multipart/form-data, name, payload]
issues: [#270]
---

A Deluge attachment request reached the webhook as raw multipart data under a non-multipart request header and fell through to URL-encoded parsing; live replays against the running route showed that its original double-quote-only disposition parser rejected bare and single-quoted canonical parts. Parse `Content-Disposition` names and filenames in double-quoted, single-quoted, and bare-token forms while still requiring the first part to be exactly `payload` or `metadata` before granting multipart handling.
