---
title: A v6 participation_handler can deliver data.message as a JSON string
files: src/inbound.ts
apis: participation_handler,data.message,handlerSchema
---

A Deluge schema **v6** bot `participation_handler` can deliver a channel
`message_sent` event with `data.message` (and sometimes the top-level
`message`) as a JSON **string** such as `"{\"text\":…}"` rather than a Map.
Treating that string as text shows the agent raw JSON and drops attachments
nested inside the object, including voice notes. Parse a string that starts
with `{` back into an object — independently on the top level and on `data` —
before the participation unwrapping, and only when the decoded object carries
a known message-object key (`text`, `content`, `attachments`, `file`, …) so a
user who deliberately typed JSON is not rewritten. A string that is not such a
JSON object must stay untouched. DMs through the Message handler are unaffected.
