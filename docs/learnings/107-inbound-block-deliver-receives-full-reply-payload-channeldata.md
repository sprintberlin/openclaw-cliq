---
title: Inbound buffered-block `deliver` receives the full ReplyPayload (incl. channelData) — the live-edit path is a second card route
category: OpenClaw Plugin SDK
files: [src/live-edit.ts, src/inbound.ts]
apis: [dispatchReplyWithBufferedBlockDispatcher, delivery.deliver]
issues: [#90]
---

The inbound `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher`
dispatcher invokes `dispatcherOptions.deliver(payload, info)` with the FULL
`ReplyPayload` — not just `{ text, mediaUrl }`. In particular `payload.channelData`
is preserved (the dispatcher's `hasOutboundReplyContent` check counts
`hasChannelData`, so a buttons-only card with empty text still triggers a
deliver). A channel's `delivery.deliver` wrapper therefore MUST forward
`channelData` (not only `text`) to its own delivery implementation, or interactive
replies (command menus, agent presentations) are silently dropped. The
non-placeholder reply path goes through the outbound `sendPayload` adapter; the
placeholder / live-edit path (`createLiveEditDeliver`) is a SEPARATE second
delivery route that must mirror `sendPayload`'s `channelData.cliqCard` handling
— route cards through `CliqClient.sendCard`, not the text edit loop.

A Cliq bot message cannot be EDITED to add buttons (the v2 edit endpoint only
swaps text), and Zoho rejects `DELETE` for bot messages (HTTP 400
`message_delete_failed`). So when a card reply arrives on the placeholder path
the card must be sent as a NEW message; the still-live `💭 …` placeholder is then
finalized by editing it to the card's body text (or a minimal marker) and
`placeholderConsumed` is set true so the inbound `cleanupStrayPlaceholder` does
not edit it into the `⚠️ Couldn't process that message.` failure notice. The
draft is then sealed (no further in-place edits) — a Cliq bot message either
carries buttons OR is editable text, never both.
