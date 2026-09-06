---
title: A payload contract marker can silently disable the body repair that depends on the payload grammar
category: Zoho Cliq inbound / transport
files: [src/inbound-deluge-repair.ts, src/bot-provisioning.ts, src/handler-schema.ts]
apis: [payload.put, handlerSchema, readJsonBody, JSON.parse]
issues: [#227, #228]
---

The `handlerSchema: "v2"` marker (#228) is emitted as `payload.put("handlerSchema", "v2")` directly after `handler`. The Deluge body repair (#227) matched `{"handler":"…","message":"` as one fixed grammar, so the new key between them made the pattern miss and a corrupt forward 400'd again — the exact production bug both changes existed to prevent.

Both changes were individually correct and fully tested. The full suite (2290 tests) stayed green, because every repair fixture still described the pre-marker body. Only a loopback POST against the deployed gateway — a body shaped exactly like Zoho's live corruption, including the new marker — exposed it.

Rules that follow:

- Any repair keyed on a generated payload's grammar must tolerate additional machine-generated fields. The repair now skips well-formed `"key":"value"` pairs (no quote, backslash or newline in the value) between `handler` and `message`, so the next contract marker cannot disable it again. A corrupted marker value still declines rather than guessing a boundary.
- When a change adds a field to a generated payload, update every fixture that encodes that payload's shape — including fixtures of *other* features that parse it. Green tests only prove the shapes the fixtures describe.
- A deploy-time probe against the real route belongs in the release step for transport-level fixes. Unit tests validate the parser; only the live route validates the parser plus the current generated payload plus the loaded build.
