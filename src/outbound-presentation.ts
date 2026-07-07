/**
 * Outbound `renderPresentation` + `sendPayload` adapters: render agent-emitted
 * portable `MessagePresentation` payloads into native Cliq bot-message cards.
 *
 * The runtime delivery path (deliver-DGFKMFsl.js) is:
 *  1. When a reply payload carries `presentation`, the runtime calls
 *     `outbound.renderPresentation({ payload, presentation, ctx })` to convert
 *     it into a channel-native `ReplyPayload`. We attach the rendered card
 *     (buttons + body text) to `payload.channelData.cliqCard` and merge the
 *     presentation's text blocks into the payload text. The runtime then
 *     strips the `presentation` field from the returned payload.
 *  2. Because the payload now has non-empty `channelData`, the runtime calls
 *     `outbound.sendPayload(ctx)` (instead of `sendText`). `sendPayload`
 *     detects the card and routes through `CliqClient.sendCard`; remaining
 *     text chunks (over the 5000-char cap) go through `sendMessage`. When no
 *     card is present it falls back to the standard `sendMessage` path.
 *
 * This is the *reply-side* rendering path (agent-emitted presentations on a
 * reply / block-streaming preview). The explicit `message(action=send,
 * buttons=[...])` tool path (see `message-actions.ts`) is the *agent-tool*
 * path. Both share `CliqClient.sendCard` under the hood.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ReplyPayload } from "openclaw/plugin-sdk/core";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundPayloadContext,
} from "openclaw/plugin-sdk/channel-runtime";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";

import {
  chunkMessage,
  normalizeCliqRouteTarget,
  resolveCliqConfig,
  type ResolvedCliqAccount,
} from "./client.js";
import { markdownToCliq } from "./markdown.js";
import { resolveCliqClient } from "./runtime-api.js";
import { CliqSendError } from "./send-retry.js";
import {
  CLIQ_PRESENTATION_CAPABILITIES,
  presentationToCliqCard,
  type CliqButton,
  type PortablePresentation,
} from "./presentation.js";

const CLIQ_TEXT_CHUNK_LIMIT = 5000;
const CLIQ_CARD_CHANNEL_DATA_KEY = "cliqCard";

/** Rendered card attached to `ReplyPayload.channelData` for the sendPayload path. */
export interface CliqRenderedCard {
  text?: string;
  buttons?: CliqButton[];
  /** v3 Message Card theme (v3 opt-in only; v2 ignores this). */
  theme?: "modern-inline" | "prompt";
}

/** Type guard for the `cliqCard` marker on `payload.channelData`. */
export function isCliqCardChannelData(
  value: unknown,
): value is { cliqCard: CliqRenderedCard } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const card = rec[CLIQ_CARD_CHANNEL_DATA_KEY];
  return Boolean(card && typeof card === "object" && !Array.isArray(card));
}

function resolveAccountFromCtx(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount {
  return resolveCliqConfig(cfg, accountId ?? null);
}

/**
 * Render a portable `MessagePresentation` into a Cliq-native card payload
 * attached to the reply as `channelData.cliqCard`. The agent reply text is
 * preserved and the presentation's text/context blocks are appended below it.
 *
 * Returns `null` when the presentation yields no buttons AND no body text —
 * the runtime then falls back to `renderMessagePresentationFallbackText`
 * plain-text rendering. When buttons are present, the card marker is set so
 * `sendPayload` routes through `CliqClient.sendCard`; when only text is
 * rendered (no buttons), the marker is omitted and `sendPayload` degrades to
 * the plain `sendMessage` path with the combined text.
 */
export function renderCliqPresentation(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
  ctx: ChannelOutboundPayloadContext;
}): ReplyPayload | null {
  const { payload, presentation } = params;
  const card = presentationToCliqCard(
    presentation as unknown as PortablePresentation,
  );
  const hasButtons = Boolean(card.buttons && card.buttons.length > 0);
  const cardText = card.text?.trim() ?? "";
  const payloadText = payload.text?.trim() ?? "";

  if (!hasButtons && !cardText) return null;

  // Combine the agent reply text with the presentation body (title + text /
  // context blocks). Agent text first, card text appended below — keeps the
  // visible reply intact while the presentation contributes structure.
  const combinedText =
    [payloadText, cardText].filter(Boolean).join("\n\n") || undefined;

  const channelData: Record<string, unknown> = { ...payload.channelData };
  if (hasButtons) {
    channelData[CLIQ_CARD_CHANNEL_DATA_KEY] = {
      buttons: card.buttons,
      ...(cardText ? { text: cardText } : {}),
    } satisfies CliqRenderedCard;
  }

  return {
    ...payload,
    text: combinedText,
    channelData,
  };
}

/**
 * Send a reply payload that may carry a rendered Cliq card
 * (`channelData.cliqCard`). When buttons are present, the first text chunk is
 * sent with the buttons via `CliqClient.sendCard`; any remaining chunks are
 * sent as plain messages. When no card is present, falls back to the standard
 * `sendMessage` path (mirrors `sendText`, including the rich→plain fallback on
 * a format-rejected 400).
 *
 * Text is chunked against Cliq's 5000-char cap before sending. Markdown is
 * converted to Cliq-native formatting.
 */
export async function sendCliqPayload(
  ctx: ChannelOutboundPayloadContext,
): Promise<{ channel: string; messageId: string; to: string }> {
  const account = resolveAccountFromCtx(ctx.cfg, ctx.accountId);
  const client = resolveCliqClient(account);
  const target = normalizeCliqRouteTarget(ctx.to);
  const payload = ctx.payload;
  const card = isCliqCardChannelData(payload.channelData)
    ? (payload.channelData[CLIQ_CARD_CHANNEL_DATA_KEY] as CliqRenderedCard)
    : null;
  const buttons = card?.buttons;
  const theme = card?.theme;

  const rawText = payload.text ?? "";
  const richText = rawText ? markdownToCliq(rawText) : "";
  const chunks = richText ? chunkMessage(richText, CLIQ_TEXT_CHUNK_LIMIT) : [""];

  if (buttons && buttons.length > 0) {
    // First chunk + buttons → sendCard. Remaining chunks → sendMessage.
    const firstText = chunks[0] || undefined;
    const firstResult = await client.sendCard({
      to: target.to,
      isDm: target.isDm,
      ...(firstText ? { text: firstText } : {}),
      buttons,
      ...(theme ? { theme } : {}),
    });
    for (let i = 1; i < chunks.length; i++) {
      await client.sendMessage({
        to: target.to,
        isDm: target.isDm,
        text: chunks[i],
      });
    }
    return {
      channel: "cliq",
      messageId: firstResult.messageId ?? "unknown",
      to: ctx.to,
    };
  }

  // No buttons → plain text path (mirrors sendText + rich→plain fallback).
  try {
    let lastId = "unknown";
    for (const chunk of chunks) {
      const result = await client.sendMessage({
        to: target.to,
        isDm: target.isDm,
        text: chunk,
      });
      lastId = result.messageId ?? lastId;
    }
    return { channel: "cliq", messageId: lastId, to: ctx.to };
  } catch (err) {
    if (
      err instanceof CliqSendError &&
      err.kind === "format_rejected" &&
      rawText &&
      rawText !== richText
    ) {
      let lastId = "unknown";
      for (const chunk of chunkMessage(rawText, CLIQ_TEXT_CHUNK_LIMIT)) {
        const result = await client.sendMessage({
          to: target.to,
          isDm: target.isDm,
          text: chunk,
        });
        lastId = result.messageId ?? lastId;
      }
      return { channel: "cliq", messageId: lastId, to: ctx.to };
    }
    throw err;
  }
}

/**
 * Outbound presentation adapter surface: advertised capabilities +
 * `renderPresentation` + `sendPayload`. Spread onto `outbound.base` of
 * `createChatChannelPlugin` (it `Omit`s only `sendText`/`sendMedia`/`sendPoll`,
 * so these fields are forwarded onto the resolved `ChannelOutboundAdapter`).
 */
export const cliqOutboundPresentation = {
  presentationCapabilities: CLIQ_PRESENTATION_CAPABILITIES,
  renderPresentation: renderCliqPresentation,
  sendPayload: sendCliqPayload,
} satisfies Pick<
  ChannelOutboundAdapter,
  "presentationCapabilities" | "renderPresentation" | "sendPayload"
>;

export type CliqOutboundPresentation = typeof cliqOutboundPresentation;
export type {
  CliqButton,
  PortablePresentation,
} from "./presentation.js";
