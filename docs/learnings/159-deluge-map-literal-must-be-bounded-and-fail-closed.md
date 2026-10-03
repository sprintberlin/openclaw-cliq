---
title: Deluge Map.toString() multipart fallback must be bounded and fail-closed
date: 2026-10-03
issue: 275
files: [src/inbound-deluge-repair.ts, src/inbound-webhook-body.ts]
apis: [parseDelugeMapLiteral, invokeUrl, files, stringPart, payload.toString()]
---

# Deluge Map.toString() multipart fallback must be bounded and fail-closed

The attachment branch of the generated Message handler sends original Deluge
FILE objects using `invokeUrl files:` together with a `stringPart` containing
`payload.toString()`. For maps containing nested maps or lists (e.g. `user`,
`chat`, `attachments`), Zoho Deluge does not serialize to JSON; it emits its
own unquoted literal syntax with bare keys and `=` separators:

```text
{handler=message, handlerSchema=v4, message=, user={id=10000000001, name=Dominic Offers}, chat={id=CT_dm}, attachments=[voice.wav]}
```

Because Deluge unquoted scalar syntax does not distinguish commas in user text
from field separators, a broad heuristic parser can silently misparse captions
into corrupted top-level keys.

To preserve reliability without live bot wire-format evidence:
1. **Strict envelope & ordering**: Only the generated top-level keys are accepted,
   enforcing strictly monotonic generated insertion rank (`handler` -> `handlerSchema`
   -> `message` -> `user` -> `chat` -> `eventId` -> `attachments` -> `mentions` ->
   `channel` -> `thread`). A caption containing ambiguous delimiters fails closed
   instead of restructuring the payload.
2. **Resource & nesting limits**: 64 KiB body limit, max 16 nesting depth, and max
   128 keys total.
3. **Security bounds**: Prototype-pollution keys (`__proto__`, `prototype`, `constructor`)
   are rejected at all depths, and objects are instantiated with `Object.create(null)`.
   Duplicate keys reject immediately.
4. **Identity requirements**: Both `user.id` and `chat.id` must resolve as non-empty strings.
