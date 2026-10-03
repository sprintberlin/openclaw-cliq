---
title: Deluge multipart metadata uses flat scalar stringParts, not Map.toString()
date: 2026-10-03
issue: 275
files: [src/bot-provisioning.ts, src/inbound-webhook-body.ts, src/handler-schema.ts]
apis: [invokeUrl, files, stringPart, paramName, content]
---

# Deluge multipart metadata uses flat scalar stringParts, not Map.toString()

A generated Message Handler that forwards Deluge FILE objects must use `invokeUrl files:`. Its metadata cannot safely be one `payload.toString()` stringPart: nested Maps/Lists become an unquoted Deluge map literal, and punctuation in user text is indistinguishable from structural delimiters.

Schema v5 emits one TEXT `stringPart` per required scalar field (`handler`, `handlerSchema`, `message`, `eventId`, `userId`, optional `userName`, `chatId`, optional `chatType`) and then appends the original FILE objects. Each `content` is a literal, existing string variable, or scalar `Map.get()` coerced with `"" + value`; no nested value is serialized. Multipart boundaries preserve commas, braces, brackets, equals signs, quotes, and line breaks in captions without JSON escaping.

The webhook reconstructs canonical `user` and `chat` objects from the flat parts, validates non-empty IDs, and keeps attachment bytes outside the JSON-shaped payload. The bounded map-literal parser remains only for stale v4 and earlier handlers; Doctor and provisioning identify those handlers through the schema marker and offer a confirmation-gated repair.
