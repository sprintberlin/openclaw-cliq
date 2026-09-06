# Chat-history recovery

OpenClaw-cliq uses the webhook as the primary inbound path. A Cliq message can occasionally
exist in a direct chat while no corresponding OpenClaw turn was created, for example when the
bot handler did not deliver a parseable event.

## Opt in deliberately

```jsonc
{
  "channels": {
    "cliq": {
      "inboundCatchup": { "enabled": true, "limit": 50 }
    }
  }
}
```

`limit` is 1–50 and defaults to 50. This needs the existing user-context `refreshToken`
with `ZohoCliq.Messages.READ`; without it the plugin leaves ordinary webhook delivery alone
and Doctor reports catch-up as unavailable.

## Safety boundary

Catch-up is **not** a history import, a global Cliq MCP capability, or a polling loop. It runs
only after an admitted **direct-message** webhook turn and makes at most one bounded
`GET /api/v2/chats/{chatId}/messages` call.

The first eligible live message seeds an opaque per-conversation native-message cursor and
replays nothing. Thereafter the plugin requires the history window to contain a current
same-sender/same-text live-message anchor. It considers only records strictly between that
anchor and the persisted cursor, oldest first. Every recovered native id passes through the
same in-flight/committed dedupe claim as a normal webhook delivery before Core dispatches it.

If the cursor has aged out of the bounded window, all records behind the anchored live record
are still newer than the last known lower bound and are eligible; if the live anchor is absent,
the API fails, data is malformed, the turn is a group/channel message, or a record is bot/self,
nothing is replayed. Those failures never block or alter the live turn. The local cursor state
hashes account/chat ids and stores only the opaque message id — never message text or sender
display data — in a mode-600 state file.

## Observability

Default gateway logs report either a content-free bounded recovery count or an unavailable
history/anchor condition. They never print historical content, chat ids, sender names, OAuth
tokens, refresh tokens, or the webhook secret.
