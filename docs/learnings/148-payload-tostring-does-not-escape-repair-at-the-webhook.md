---
title: Zoho's payload.toString() does not escape string values — repair at the webhook, do not drop
category: Zoho Cliq inbound / transport
files: [src/inbound-deluge-repair.ts, src/inbound.ts, index.ts]
apis: [payload.toString(), invokeUrl, readJsonBody, JSON.parse]
issues: [#223, #225, #227, #232]
---

Deluge's `Map.toString()` emits JSON-looking text but does not escape string values. A `message` containing a double quote or a line break therefore produces a body that `JSON.parse` rejects even though the payload is structurally complete. Plain messages without quotes/newlines happen to parse — which is why this survived live traffic for months.

Live proof (2026-09-05): a forwarded business instruction arrived as an authenticated 1091-byte POST (the full original text was in the body) and died at `JSON.parse` with `inbound skipped: empty_body`. The earlier theory "forwards carry no readable text" (learning 146) was wrong — the text arrived; the serialization was corrupt.

Durable fix: the webhook repairs the known corruption instead of dropping it. The generated handler's field vocabulary is fixed, but Deluge may vary insignificant whitespace and map order; the message value is re-escaped at the last parseable separator before a known generated field and the whole object is re-parsed. Rules that keep this safe:

- A body that already parses is never touched (no double-escaping, no hostile re-reading).
- If the repaired form still fails to parse, fall through to the reject path — never force a value.
- A text whose corruption happens to parse (it contains a literal `","user":`) defers to the caller's parse; real user text never contains that literal.
- A repair is accepted only when the reconstructed object contains the original free text plus object-form `user` and `chat`; separator-like literals or nested keys cannot silently truncate the message.
- Unrepairable bodies log a bounded content-free syntax fingerprint (words masked to `x*`, punctuation and marked newlines preserved) with both head and structural tail, so the next unknown corruption shape documents itself without leaking content.

Alternative rejected: fixing it in Deluge (e.g. manual escaping loops) would need new handler symbols across every install — the permanent `execution_handler_update_failed` risk — and would not help old handlers already deployed. The gateway-side repair covers all handler generations.
