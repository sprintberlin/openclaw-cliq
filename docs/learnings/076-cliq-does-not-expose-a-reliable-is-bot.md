---
title: Cliq does not expose a reliable `is_bot` flag on the webhook sender
category: Zoho Cliq specifics
source: migrated from AGENTS.md
---
- **Cliq does not expose a reliable `is_bot` flag on the webhook sender.** Unlike Telegram/Discord/Slack (`author.bot` / `bot_id` / `sender.type=BOT`), a Cliq Deluge webhook payload's `user` object has no bot discriminator. So bot-loop protection cannot rely on the SDK's `botLoopProtection` pair-loop guard (which needs *both* participant bot ids); the plugin-channel webhook handler must filter self/other-bot senders itself, by id, before dispatch. The configured `botId` (bot unique name used in the API URL) is always treated as self, `botName` too, and operators add the bot's *zuid* (Zoho user id, which is what `user.id` reports when the bot's own outgoing messages re-trigger the webhook) plus any other Cliq bots to ignore via the `selfSenderIds` config field. Matching is case-insensitive + trimmed across `senderId`/`senderName`/`senderEmail`.
