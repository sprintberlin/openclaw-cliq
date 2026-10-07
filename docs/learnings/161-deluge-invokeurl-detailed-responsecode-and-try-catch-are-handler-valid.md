# Deluge fallback syntax is accepted by isolated Message and Mention handlers

## Fact

- Zoho Cliq bot Message and Mention handlers accept a script that assigns the
  `invokeUrl` result (`delivery = invokeUrl [ ... detailed: true ];`), reads
  `delivery.get("responseCode")`, wraps the call in `try { } catch (e) { }`,
  and returns `response.put("text", ...)` beside `response.put("eventId", ...)`.
  Verified live on an isolated test bot: both handler types saved and
  re-read the script (saving runs Zoho script validation).
- Save/read-back proves syntax acceptance, not execution or user-visible delivery.
  The isolated test did not establish the runtime shape of `responseCode` or the
  caught timeout path. Those remain a live gate before merging or repairing a production bot.
- A real isolated DM with a static script returning both `text` and `eventId` in
  the same Map produced no visible bot reply (`T260DM-14`). A subsequent static
  script returned only `text`, with a generated reference embedded in its value,
  and produced one visible reply (`T260DM-15`, Ref `20261007110555-678404`).
  Thus failure must replace the success eventId Map with a text-only Map; merely
  adding `text` to the success Map does not satisfy the user-visible fallback.
- After replacing the failure Map, isolated Message-handler DMs were sent through
  a real Cliq client. With the `detailed: true` status check, 200 and 204
  generated no additional reply; 400, 401, 405, 413, 500, and 503 each
  generated exactly one visible generic reply with a numeric event reference.
  A refused connection produced one identical generic reply via `catch (e)`.
  An actual channel mention selected from Cliq autocomplete triggered the
  isolated Mention handler at 400 and produced one visible generic reply
  (Ref `20261007113527-833732`). This proves the native handler response
  shape, not a direct bot-send API response. The full v6 Message and Mention
  scripts were also saved and read back on the isolated bot (HTTP 204/200),
  with the text-only branches and v6 marker present. A separate permission
  prompt for that full-script external API prevented a full-generator runtime
  trigger; do not claim that part was executed end to end.

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
