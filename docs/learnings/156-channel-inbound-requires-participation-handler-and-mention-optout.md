# 156. Channel Inbound Requires Participation Handler and Mention Opt-Out

- **Cliq delivers channel messages without an @-mention exclusively through `participation_handler`.** `message_handler` fires only in DMs; `mention_handler` fires in channels only when the bot is explicitly tagged.
- **Both Zoho and OpenClaw gates must align for channel inbound:**
  1. **Zoho bot:** Must declare a provisioned `participation_handler` intercepting `operation == "message_sent"`.
  2. **Zoho channel:** Bot must be added as a channel member.
  3. **OpenClaw config:** Channel unique name must be present in `channels.cliq.groups.<unique_name>` with `requireMention: false`.
- **Diagnostic fingerprint:**
  - Inbound webhook never hits Gateway ➔ `participation_handler` missing in Zoho Console, or bot is not in the channel.
  - Gateway logs `[cliq] inbound skipped: not_mentioned` ➔ Handler fired, but channel lacks `requireMention: false` in Gateway config.
