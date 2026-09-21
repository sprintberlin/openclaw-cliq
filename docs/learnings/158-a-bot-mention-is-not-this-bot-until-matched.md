# A bot mention is not this bot until matched

Zoho's Mention handler fires only for **this** bot. The Message and Participation handlers, however, can forward the full `mentions[]` array from a channel message — including `@Paula` when this bot is Zora.

`type: "bot"` is therefore not proof that we were addressed. Match mention ids and display names (trimmed, case-insensitive) against `botId` / `botName` / `ownSenderIds`. Keep other workspace bots in `selfSenderIds` so their *posts* are dropped, but never so a reply to or mention of them counts as directed at us.

The same split applies to reply/quote context: `isReplyToBot` must use the own-identity set, not the ignore list. Channel bot posts arrive with Cliq's internal `b-…` id, not the unique name, so operators must list that id in `ownSenderIds`.

Unaddressed `/model` chatter on an always-on channel is ambient noise, not an authorized native command. DMs, `@this-bot /model`, and replies to this bot stay authorized (#91).
