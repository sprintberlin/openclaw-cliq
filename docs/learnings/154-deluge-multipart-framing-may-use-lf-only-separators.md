---
title: Deluge multipart framing may use LF-only separators
files: [src/inbound-webhook-body.ts]
apis: [invokeUrl, files, multipart/form-data, CRLF, LF]
issues: [#270]
---

A live replay reached `/cliq/webhook` with a canonical first `payload` part but LF-only multipart framing; the CRLF-only sniffer fell through to URL-encoded parsing and dropped the request before agent dispatch. Detect and parse both CRLF and LF framing while retaining the canonical first-part check before granting multipart handling or the larger attachment-size limit.
