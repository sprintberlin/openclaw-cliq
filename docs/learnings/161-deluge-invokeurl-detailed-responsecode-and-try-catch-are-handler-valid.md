# Deluge fallback syntax is accepted by isolated Message and Mention handlers

## Fact

- Zoho Cliq bot Message and Mention handlers accept a script that assigns the
  `invokeUrl` result (`delivery = invokeUrl [ ... detailed: true ];`), reads
  `delivery.get("responseCode")`, wraps the call in `try { } catch (e) { }`,
  and returns `response.put("text", ...)` beside `response.put("eventId", ...)`.
  Verified live on an isolated test bot: both handler types saved and
  re-read the script (saving runs Zoho script validation).
- Save/read-back proves syntax acceptance, not execution or user-visible delivery.
  The isolated test did not establish the runtime shape of `responseCode`, the
  caught timeout path, or whether the returned `text` renders in the originating
  chat. Those remain a live gate before merging or repairing a production bot.

## Consequence

- The last component that can answer the user when the gateway rejects or
  cannot complete a delivery is the Zoho-held handler. The gateway cannot
  reply after body-parse failure because the chat address is inside the
  unreadable body (#260).
- Keep the fallback generic and at most once per execution: no status,
  exception, URL, secret, or message content — only the eventId reference.
- Do not retry inside the handler; durable retry belongs to the queue child.
- The scripts still must be validated on an isolated bot before changing the
  generator: `execution_handler_update_failed` is permanent (learning 146).

Tags: #260, handler, invokeUrl, detailed, responseCode, try-catch, fallback
Files: src/bot-provisioning.ts, src/handler-schema.ts
APIs: invokeUrl, detailed, responseCode, execution_handler_update_failed
