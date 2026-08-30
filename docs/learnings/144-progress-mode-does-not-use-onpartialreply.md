---
title: Progress mode owns the draft through compositor callbacks, not onPartialReply
files: [src/progress-draft.ts, src/inbound.ts]
apis: [createChannelProgressDraftCompositor, onPartialReply, onToolStart, suppressDefaultToolProgressMessages, preserveProgressCallbackStartOrder]
issues: [#208]
---

OpenClaw `streaming.mode: "progress"` is driven by typed `GetReplyOptions` lifecycle callbacks into `createChannelProgressDraftCompositor`. `onPartialReply` remains the `"partial"` answer-preview path and must stay unwired in progress mode, or a model snapshot overwrites the compositor-owned draft before `markFinalReplyStarted()`. Core owns the 1.5s start gate, line merge, and `suppressDefaultToolProgressMessages`; the channel only maps callbacks, sets `preserveProgressCallbackStartOrder`, and yields while `onVerboseProgressVisibility` reports standalone verbose progress as active.
