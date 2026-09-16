---
title: Deluge multipart may omit the blank line after part headers
files: [src/inbound-webhook-body.ts]
apis: [invokeUrl, files, Content-Disposition, multipart/form-data, blank line]
issues: [#272]
---

Live attachment DMs on 2026-09-16 reached `/cliq/webhook` as multipart whose part headers ran directly into the part content with no blank separator line (plus LF framing and unquoted `name=`). The fixed CRLFCRLF/LFLF header-terminator search failed, the body fell through to URL-encoded parsing, and the turn was dropped as `parser_rejected` with the boundary token as the first form key. Scan part headers line-by-line: the block ends at a blank line or at the first non-header-shaped line, and accept CRLF or LF before each subsequent delimiter independently of the first part's framing.
