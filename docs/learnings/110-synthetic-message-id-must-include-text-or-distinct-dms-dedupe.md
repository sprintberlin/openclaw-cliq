---
title: The synthetic message id must include the message text — otherwise distinct DM messages collide and are dropped as duplicates
category: Zoho Cliq inbound / dedupe
files: [src/inbound.ts, src/dedupe.ts]
apis: [buildSyntheticMessageId, buildCliqDedupeKey, claimCliqMessage]
issues: []
---

A Cliq **bot Message handler** delivers `message` as a bare **string** — so the
inbound payload has **no `message.id` AND no `message.time`** (both only exist on
the object-form `message` that group/mention handlers deliver). When
`message.id` is absent the plugin derives a synthetic id via
`buildSyntheticMessageId(senderId, chatId, attachments, payloadTime, text)`, and
`buildCliqDedupeKey` keys the dedupe cache on that id (`cliq:{ns}:mid:{id}`) —
the text-inclusive composite fallback (`cmp:sender:chat:text`) is only reached
when `messageId` is empty, which it is NOT once a synthetic id is assigned.

**The bug:** the synthetic id originally hashed only `senderId + chatId +
(payloadTime?) + attachments`. For a text DM `payloadTime` is empty (string
message) and there are no attachments, so the hash reduced to
`hash(senderId + chatId)` — a **constant** for every text message a user sends
in a given chat. With the 30-minute in-memory dedupe TTL, the FIRST message was
claimed + committed and then **every subsequent message from that user in that
chat was dropped as a "duplicate" for 30 minutes**, until a gateway restart
cleared the in-memory cache. Symptoms looked random: `/model` worked right after
a restart, then `hallo` worked but a following `/model` "did nothing"; `/models`
appeared to "kill the bot" (it and everything after it shared the one committed
id). The `[cliq] inbound … skipped as duplicate` line only logs under
`--verbose`, so at the default log level the dropped messages produced **zero**
output — indistinguishable from "never reached the gateway".

**Fix:** include the message `text` in the synthetic-id hash. Distinct messages
(`hallo` ≠ `/model` ≠ `/models`) now get distinct ids and are all processed; a
genuine Cliq redelivery of the *same* message carries identical text → identical
id → still correctly deduped. (A user re-sending the exact same text within the
TTL is still deduped — acceptable; the proper long-term fix is for the Deluge
message handler to forward a real `message.id` or `message.time`, which would
also distinguish legitimate identical re-sends from redeliveries.)

Takeaway: any content-hash used as a message identity key for the bot Message
handler MUST include the message text — sender+chat alone is not unique per
message, because the handler gives you neither an id nor a timestamp.
