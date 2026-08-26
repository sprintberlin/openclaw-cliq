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
(`hallo` ≠ `/model` ≠ `/models`) get distinct ids and are all processed; a
genuine Cliq redelivery of the *same* message carries identical text → identical
id → still correctly deduped. Identical content remains indistinguishable from a
redelivery, so `syn:` and composite keys use the short redelivery-window TTL;
real message ids retain the longer replay-protection TTL. The Deluge handler
cannot supply a real `message.id` or `message.time` for bare-string messages.

Takeaway: any content-hash used as a message identity key for the bot Message
handler MUST include the message text — sender+chat alone is not unique per
message, because the handler gives you neither an id nor a timestamp.
