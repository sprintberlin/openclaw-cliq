import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { withSendRetry, type RetryOptions } from "./send-retry.js";
import {
  getCliqDefaultLogger,
  truncateForLog,
  type CliqLogger,
} from "./logger.js";
import type { CliqButton } from "./presentation.js";
import { cliqCardToV3MessageCard, type V3CardSectionInput, type V3CardSlideInput } from "./v3-card.js";
import { resolveCliqSecretString } from "./secret-resolve.js";
import { paginateList } from "./pagination.js";
import {
  appendCliqDataCenterHint as appendDcHint,
  findCliqDataCenterByApiBase,
  findCliqDataCenterByApiDomain,
} from "./region.js";

const EU_API_BASE = "https://cliq.zoho.eu";
const EU_OAUTH_BASE = "https://accounts.zoho.eu";

const MESSAGE_CHAR_LIMIT = 5000;


/** REST API generation used for outbound calls that have a v3 equivalent. */
export type CliqApiVersion = "v2" | "v3";

/**
 * Outbound endpoint families and their v3 readiness:
 *  - channel **text** posts → v3 available (opt-in via `apiVersion: "v3"`).
 *  - bot **DM** posts → v3 available (opt-in via `apiVersion: "v3"`); routes
 *    through the v3 "Send a bot message" endpoint
 *    `POST /api/v3/bots/{botId}/messages` with `user_ids` + `sync_message`
 *    (scope `ZohoCliq.Webhooks.CREATE` — same as v2 DMs, no refresh token).
 *  - message **delete** → v3 available (opt-in via `apiVersion: "v3"`); uses
 *    the v3 "Delete multiple messages" endpoint
 *    `DELETE /api/v3/chats/{chatId}/messagess?message_ids=<id>` with a single
 *    id (scope `ZohoCliq.Messages.DELETE` — user-context, refresh-token
 *    grant, same constraint as `Messages.UPDATE`). v3 has NO single-message
 *    delete endpoint, only the bulk one — a 1-element delete-multiple call.
 *  - channel **card/button** posts → v3 available (opt-in via
 *    `apiVersion: "v3"`, channel/non-DM only); routes through the v3 Message
 *    Card endpoint `POST /api/v3/channels/{name}/message` (note: `channels`,
 *    not `channelsbyname`, singular `message`) with scope
 *    `ZohoCliq.Channels.CREATE` and a `modern-inline` Message Card body
 *    (header + optional text slide + action buttons) rendered by
 *    `cliqCardToV3MessageCard`. DM cards stay v2 (the v3 Message Card DM
 *    endpoint needs a chat id the DM send path does not have). The v3 docs
 *    do not document a `bot_unique_name` query param, so a v3 channel card
 *    posts AS THE AUTHENTICATED USER (not as the bot).
 *  - channel **media** posts, message edit / list, reactions, directory,
 *    file download, channel-chat-id resolution → v2 only. Confirmed against
 *    the v3 REST docs: v3 Messages has only delete-multiple, post, forward,
 *    search (no single-message edit or get); v3 Chats has no message
 *    operations at all; v3 has no reactions endpoint anywhere (not under
 *    Messages, Chats, or Threads — only Stars + Pin Messages exist as
 *    reaction-adjacent surfaces); v3 has no Files API and no channelsbyname
 *    lookup (v3 chat retrieval is by CHAT_ID, not by unique name). These
 *    families therefore stay v2 indefinitely (v3 dead ends — no swap
 *    available). The message-delete family was migrated in its own
 *    increment (v3 bulk-delete with a 1-element `message_ids` list, scope
 *    `Messages.DELETE`); the channel card/button family was migrated in its
 *    own increment (v3 Message Card `modern-inline`, scope `Channels.CREATE`).
 *
 * v3 channel text post: `POST /api/v3/channelsbyname/{name}/messages` with
 * body `{ text, reply_to?, sync_message? }` and the
 * `ZohoCliq.Webhooks.CREATE` scope (obtainable via `client_credentials` —
 * unlike the v2 channel endpoint, which requires `ZohoCliq.Channels.UPDATE`
 * and therefore a user-context refresh token). v3 returns `204 No response`
 * with no message id (live-edit recovers via the existing
 * `resolveChannelChatId` + `listChatMessages` path). v3 does NOT support a
 * `buttons` field (buttons moved to Message Cards in v3), so `sendCard`
 * stays on v2 regardless of `apiVersion`.
 */
export interface CliqChannelConfig {
  clientId?: string;
  /**
   * OAuth `client_credentials` grant secret. May be a plaintext string or a
   * structured SecretRef (the form `openclaw secrets apply` rewrites plaintext
   * into); resolved to a literal string by `resolveCliqConfig` via
   * `resolveCliqSecretString` (plaintext + env-backed refs synchronously).
   */
  clientSecret?: SecretInput;
  botId?: string;
  botName?: string;
  /**
   * Shared secret used to verify `x-cliq-webhook-secret` on inbound delivery.
   * Plaintext or SecretRef (resolved at runtime). Recommended; when unset (or
   * when a configured ref cannot be resolved) inbound verification is skipped.
   */
  webhookSecret?: SecretInput;
  allowFrom?: string[];
  dmPolicy?: string;
  /**
   * Additional sender ids / names / emails whose inbound messages are
   * silently dropped as "self" (never dispatched to an agent). Use this to
   * ignore the bot's own alternate identity (e.g. its Zoho user id when the
   * webhook delivers a zuid that differs from `botId`) and other Cliq bots
   * in the same workspace that must not trigger this agent (bot-to-bot
   * loop prevention). The bot's own `botId` and `botName` are always
   * treated as self implicitly; this list is for *additional* identities.
   */
  selfSenderIds?: string[];
  /**
   * When the webhook acknowledges Cliq relative to the inbound dispatch.
   * - `"after_dispatch"` (default): await `runtime.channel.inbound.run`
   *   before sending HTTP 200. A crash mid-dispatch means Cliq never sees
   *   the 200 and redelivers (no lost message). On dispatch error the
   *   webhook returns 500 so Cliq redelivers.
   * - `"immediate"`: fire-and-forget (legacy behavior). Faster, but a
   *   crash between ack and dispatch completion loses the message. Use only
   *   when the Cliq/Deluge `invokeUrl` timeout is tighter than the agent
   *   round-trip and you accept the lost-message risk.
   */
  ackPolicy?: "after_dispatch" | "immediate";
  /**
   * Streaming preview configuration. The SDK coalesces agent output into
   * progressive "block" deliveries (separate messages) rather than waiting
   * for the full reply, when block streaming is enabled. Plugin-channel
   * live-edit-in-place (editing a single message as the draft grows) is not
   * exposed by the SDK; block streaming is the available progressive-delivery
   * mechanism.
   * - `preview: "on"` opts this account into block streaming (the SDK's
   *   `agents.defaults.blockStreamingDefault` must also permit it).
   * - `preview: "off"` (default) keeps the legacy single-final-reply behavior.
   */
  streaming?: { preview?: "on" | "off" };
  /**
   * Optional user-context OAuth **refresh token** obtained once via the
   * self-client `authorization_code` flow (see README §3). When set, the
   * client mints access tokens via `grant_type=refresh_token` for the
   * outbound paths that require a *user-consented* token — channel posts
   * (`ZohoCliq.Channels.UPDATE`) and message edits
   * (`ZohoCliq.Messages.UPDATE`) — because the `client_credentials` grant
   * cannot obtain a usable token for those scopes (Zoho issues a token
   * that reports the scope but rejects it on use with
   * `oauthtoken_scope_invalid`). Bot DMs (`ZohoCliq.Webhooks.CREATE`)
   * keep using `client_credentials`. When unset, behavior is unchanged
   * (client_credentials for everything; channel posts / edits will fail
    * at the API with a scope error — i.e. DM-only setups keep working).
    *
    * May be a plaintext string or a structured SecretRef (resolved at runtime
    * by `resolveCliqConfig` via `resolveCliqSecretString`).
    */
    refreshToken?: SecretInput;
  /**
   * Reaction guidance for the agent's system prompt. Cliq supports outbound
   * reactions (the `react` message-action), so the default is `"minimal"`
   * (react sparingly for acknowledgements / sentiment). Set to `"extensive"`
   * to encourage liberal reactions, or `"off"` to suppress the reactions
   * prompt section entirely.
   */
  reactions?: CliqReactionGuidanceConfig;
  /**
   * Instant acknowledgement / "thinking" placeholder. When `mode === "placeholder"`
   * and a `refreshToken` is configured and streaming preview is OFF, the
   * inbound path posts a lightweight placeholder message (e.g. `💭 …`) the
   * moment a message is accepted, then edits it in place into the final
   * agent reply — exactly one message, no duplicate. Default `"off"` (opt-in;
   * avoids a surprise extra API call per turn). See issue #47.
   */
  thinking?: CliqThinkingConfig;
  /**
   * Welcome-message-on-subscribe config. When the Deluge Welcome Handler
   * forwards a subscribe event and `welcome.enabled === true`, the bot posts
   * a greeting DM to the subscriber (honoring `dmPolicy` / `allowFrom`). See
   * {@link CliqWelcomeConfig} for the field shape.
   */
  welcome?: CliqWelcomeConfig;
  /**
   * Override the hard-coded EU REST API base (`https://cliq.zoho.eu`).
   * Intended for self-hosted / alternate Zoho data centers and for
   * hermetic testing (pointing at a local mock). When unset the EU
   * endpoint is used.
   */
  apiBase?: string;
  /**
   * Override the hard-coded EU OAuth base (`https://accounts.zoho.eu`).
   * Same use case as `apiBase`. When unset the EU endpoint is used.
   */
  oauthBase?: string;
  /**
   * REST API generation to use for the outbound endpoint families that have a
   * v3 equivalent. `"v2"` (default) keeps the verified-live v2 paths; `"v3"`
   * opts the channel text-post family into the v3
   * `POST /api/v3/channelsbyname/{name}/messages` endpoint, the bot DM
   * family into the v3 `POST /api/v3/bots/{botId}/messages` endpoint, AND
   * the message-delete family into the v3
   * `DELETE /api/v3/chats/{chatId}/messagess?message_ids=<id>` endpoint —
   * the text + DM paths both use the `ZohoCliq.Webhooks.CREATE` scope
   * (obtainable via `client_credentials`, removing the refresh-token
   * requirement for channel text posts — see README §3c); the delete path
   * uses the `ZohoCliq.Messages.DELETE` scope (user-context, refresh-token
   * grant — same constraint as the v2 `Messages.UPDATE` delete path). The
   * v3 DM endpoint posts AS the bot (sender identity preserved, unlike
   * `POST /api/v3/chats/{chatId}/messages` which posts as the authenticated
   * user), uses `user_ids` (comma-separated) instead of v2's `userids`, and
   * sets `sync_message: true` so the response carries the message id + chat
   * id for live-edit. The v3 delete path is a 1-element delete-multiple call
   * (v3 has no single-message delete endpoint) and parses the per-message
   * `message.delete_result` response. The v3 channel **card/button** post
   * family routes through the v3 Message Card endpoint
   * `POST /api/v3/channels/{name}/message` (note: `channels`, not
   * `channelsbyname`, singular `message`) with scope `ZohoCliq.Channels.CREATE`
   * and a `modern-inline` Message Card body (header + optional text slide +
   * action buttons); the v3 docs do not document a `bot_unique_name` query
   * param, so a v3 channel card posts AS THE AUTHENTICATED USER (not as the
   * bot — users who need bot sender identity for cards stay on `"v2"`). The
   * v3 DM **card/button** post family routes through the v3 "Send a bot
   * message" endpoint `POST /api/v3/bots/{botId}/messages` (the SAME endpoint
   * the v3 DM text post uses) with scope `ZohoCliq.Webhooks.CREATE`
   * (client_credentials, NO refresh token required); the v3 bot-message
   * endpoint accepts a top-level `card` object and posts AS THE BOT (sender
   * identity preserved), addressing recipients via `user_ids` — so no chat-id
   * resolution is needed (unlike the dedicated v3 Message Card chat endpoint
   * `POST /api/v3/chats/{chatId}/messages`, which posts as the user and
   * needs a chat id the DM send path does not have). Other families (media,
   * edits, list, reactions, directory, file download, channel-chat-id resolution) stay on v2 —
   * confirmed against the v3 REST docs these are v3 dead ends with no swap
   * available (v3 Messages has no single-message edit or get endpoint; v3
   * has no reactions endpoint anywhere; v3 has no Files API; v3 chat
   * retrieval is by CHAT_ID, not by unique name). Migrating is incremental
   * and per-family so the core never regresses in one change.
   */
  apiVersion?: CliqApiVersion;
}

/** Per-account reaction-guidance config (under `channels.cliq.reactions`). */
export type CliqReactionGuidanceConfig = {
  agentGuidance?: "minimal" | "extensive" | "off";
};

/** Instant-acknowledgement / "thinking" placeholder config (under `channels.cliq.thinking`). */
export type CliqThinkingConfig = {
  /**
   * - `"off"` (default): no instant acknowledgement.
   * - `"placeholder"`: post a lightweight text placeholder (e.g. `💭 …`)
   *   immediately, then edit it in place into the final reply.
   * - `"card"`: post a v3 Message Card status indicator (a `modern-inline`
   *   card) instead of plain text, and transition its title through explicit
   *   phases as the turn progresses: the card is first posted with the
   *   "thinking" phase title (`thinkingText`, default `💭 thinking…`), then
   *   edited in place to the "generating" phase title (`text`, default
   *   `Generating…`) right before the agent turn dispatches, and finally
   *   edited into the reply text in place when the reply arrives (the
   *   existing edit-into-reply path). On `apiVersion: "v3"` this is a real
   *   card (DM via `POST /api/v3/bots/{botId}/messages` with scope
   *   `Webhooks.CREATE`, channel via `POST /api/v3/channels/{name}/message`
   *   with scope `Channels.CREATE`); on v2 it degrades to the plain-text
   *   placeholder (v2 has no buttonless card). The card becomes the
   *   `initialDraft` the live-edit flow replaces: when the reply arrives the
   *   card is edited into the reply text in place (when the edit API accepts
   *   a card→text swap) or deleted + the reply sent fresh (the existing
   *   edit-failure fallback). No new OAuth scope (reuses the card-path +
   *   `Messages.UPDATE` scopes).
   */
  mode?: "off" | "placeholder" | "card";
  text?: string;
  /**
   * The initial "thinking" phase title for a `thinking.mode === "card"`
   * status card (posted the moment a message is admitted), before it is
   * edited into the "generating" phase title (`text`) right before the
   * agent turn dispatches. Defaults to `💭 thinking…`. Card-mode only;
   * ignored for `"placeholder"` / `"off"`.
   */
  thinkingText?: string;
  /**
   * Text the placeholder is edited into when the agent turn ends with no
   * reply produced (the turn threw, or the dispatcher flushed no blocks).
   * When unset, the untouched placeholder is DELETED instead so no stray
   * `💭 …` lingers. Editing needs the same `refreshToken` as the placeholder
   * itself; when the edit fails the placeholder is deleted as a fallback.
   */
  failureText?: string;
};

/** Default placeholder text posted when `thinking.mode === "placeholder"`. */
export const DEFAULT_CLIQ_THINKING_TEXT = "💭 …";

/** Default title for a `thinking.mode === "card"` status card ("generating" phase). */
export const DEFAULT_CLIQ_THINKING_CARD_TEXT = "Generating…";

/** Default initial "thinking" phase title for a `thinking.mode === "card"` status card. */
export const DEFAULT_CLIQ_THINKING_CARD_THINKING_TEXT = "💭 thinking…";

/**
 * Welcome-message-on-subscribe config (under `channels.cliq.welcome`). The
 * Cliq bot **Welcome Handler** fires when a user subscribes (or re-subscribes)
 * to the bot; when the Deluge handler forwards that event to our webhook and
 * `welcome.enabled === true`, the bot posts a configurable greeting DM to the
 * subscriber. `text` is used for first-time subscribers, `textRejoin` for
 * users who unsubscribed and came back. Both support `{{firstName}}` /
 * `{{lastName}}` / `{{name}}` / `{{id}}` / `{{email}}` placeholders resolved
 * from the forwarded `user` object. The DM admission policy (`dmPolicy` /
 * `allowFrom`) is honored — a denied sender is never greeted.
 */
export type CliqWelcomeConfig = {
  enabled?: boolean;
  text?: string;
  textRejoin?: string;
};

/** Default greeting for a first-time subscriber. */
export const DEFAULT_CLIQ_WELCOME_TEXT =
  "👋 Hi {{firstName}}! Thanks for subscribing. Send me a message to get started.";
/** Default greeting for a returning (re-subscribing) user. */
export const DEFAULT_CLIQ_WELCOME_REJOIN_TEXT =
  "👋 Welcome back, {{firstName}}!";

export interface ResolvedCliqAccount {
  accountId: string | null;
  clientId: string;
  clientSecret: string;
  botId: string;
  botName?: string;
  webhookSecret?: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
  ackPolicy: "after_dispatch" | "immediate";
  selfSenderIds: string[];
  /** Whether progressive (block-streaming) reply delivery is opted-in for this account. */
  blockStreaming: boolean;
  /**
   * Optional user-context refresh token (see `CliqChannelConfig.refreshToken`).
   * When set, channel posts + message edits mint access tokens via the
   * refresh-token grant; otherwise those paths fall back to
   * `client_credentials` (which only works for bot DMs).
   */
  refreshToken?: string;
  /** Resolved REST API base (EU default unless overridden in config). */
  apiBase?: string;
  /** Resolved OAuth base (EU default unless overridden in config). */
  oauthBase?: string;
  /**
   * Resolved REST API generation for the endpoint families that have a v3
   * equivalent (channel text posts + bot DM posts + message delete + DM
   * cards). Defaults to `"v2`; per-account overrides apply via the
   * shallow-merge resolution (so one account can pilot v3 while others stay
   * on v2). See {@link CliqChannelConfig.apiVersion}. Optional on the resolved
   * type so test fixtures can omit it; `resolveCliqConfig` always sets it and
   * `CliqClient` defaults to `"v2"` when undefined.
   */
  apiVersion?: CliqApiVersion;
  /**
   * Resolved instant-acknowledgement config. `mode` defaults to `"off"`; `text`
   * defaults to {@link DEFAULT_CLIQ_THINKING_TEXT} when `mode === "placeholder"`
   * and to {@link DEFAULT_CLIQ_THINKING_CARD_TEXT} when `mode === "card"`.
   * The inbound path only acts when `mode` is `"placeholder"` OR `"card"` AND a
   * `refreshToken` is configured AND streaming preview is off (the live-edit
   * path already shows progress otherwise).
   */
  thinking: {
    mode: "off" | "placeholder" | "card";
    text: string;
    thinkingText?: string;
    failureText?: string;
  };
  /**
   * Resolved welcome-on-subscribe config. `enabled` defaults to `false`
   * (opt-in — no setup gets a surprise greeting DM). `text` / `textRejoin`
   * default to {@link DEFAULT_CLIQ_WELCOME_TEXT} /
   * {@link DEFAULT_CLIQ_WELCOME_REJOIN_TEXT} when `enabled === true`.
   */
  welcome: { enabled: boolean; text: string; textRejoin: string };
}

export function resolveCliqConfig(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount {
  const effective = readEffectiveCliqSection(cfg, accountId);
  const section = effective.section;
  const clientId = section?.clientId;
  const secretPathPrefix = effective.isPerAccount
    ? `channels.cliq.accounts.${effective.accountId}`
    : "channels.cliq";
  const clientSecret = resolveCliqSecretString({
    cfg,
    value: section?.clientSecret,
    path: `${secretPathPrefix}.clientSecret`,
  });
  const botId = section?.botId;
  if (!clientId) throw new Error("cliq: clientId is required");
  if (!clientSecret) throw new Error("cliq: clientSecret is required");
  if (!botId) throw new Error("cliq: botId is required");
  const ackPolicyRaw = section?.ackPolicy;
  const ackPolicy: "after_dispatch" | "immediate" =
    ackPolicyRaw === "immediate" ? "immediate" : "after_dispatch";
  const blockStreaming = section?.streaming?.preview === "on";
  const webhookSecret = resolveCliqSecretString({
    cfg,
    value: section?.webhookSecret,
    path: `${secretPathPrefix}.webhookSecret`,
  });
  const refreshToken = resolveCliqSecretString({
    cfg,
    value: section?.refreshToken,
    path: `${secretPathPrefix}.refreshToken`,
  });
  return {
    accountId: effective.accountId,
    clientId,
    clientSecret,
    botId,
    botName: section?.botName,
    webhookSecret: webhookSecret || undefined,
    allowFrom: section?.allowFrom ?? [],
    dmPolicy: section?.dmPolicy,
    ackPolicy,
    selfSenderIds: section?.selfSenderIds ?? [],
    blockStreaming,
    refreshToken: refreshToken || undefined,
    apiBase: section?.apiBase || undefined,
    oauthBase: section?.oauthBase || undefined,
    apiVersion: section?.apiVersion === "v3" ? "v3" : "v2",
    thinking: {
      mode: section?.thinking?.mode === "placeholder"
        ? "placeholder"
        : section?.thinking?.mode === "card"
          ? "card"
          : "off",
      text: section?.thinking?.text
        ?? (section?.thinking?.mode === "card"
          ? DEFAULT_CLIQ_THINKING_CARD_TEXT
          : DEFAULT_CLIQ_THINKING_TEXT),
      thinkingText:
        section?.thinking?.mode === "card"
          ? (section?.thinking?.thinkingText || DEFAULT_CLIQ_THINKING_CARD_THINKING_TEXT)
          : undefined,
      failureText: section?.thinking?.failureText || undefined,
    },
    welcome: {
      enabled: section?.welcome?.enabled === true,
      text: section?.welcome?.text || DEFAULT_CLIQ_WELCOME_TEXT,
      textRejoin: section?.welcome?.textRejoin || DEFAULT_CLIQ_WELCOME_REJOIN_TEXT,
    },
  };
}

/** The single-account convention id (no `accounts.*` nesting). */
export const CLIQ_DEFAULT_ACCOUNT_ID = "default";

export interface EffectiveCliqSection {
  section: CliqChannelConfig | undefined;
  accountId: string | null;
  /** Whether resolution came from a per-account override (`accounts.<id>`). */
  isPerAccount: boolean;
}

function readTopLevelCliqSection(
  cfg: OpenClawConfig,
): CliqChannelConfig | undefined {
  const channels = (cfg as unknown as {
    channels?: Record<string, CliqChannelConfig | undefined>;
  }).channels;
  return channels?.["cliq"];
}

/**
 * Read the effective Cliq section for an account: a per-account override
 * (`channels.cliq.accounts.<accountId>`) overlaid on the top-level
 * `channels.cliq` section. This is what makes multi-bot / multi-account configs
 * work — each account can carry its own credentials, botId, allowFrom, …,
 * while shared config (webhookSecret, dmPolicy) can live at the top level.
 *
 * Resolution rules:
 *  - `accountId` null/undefined/`"default"` → top-level section verbatim
 *    (the single-account convention; backward compatible).
 *  - Non-default `accountId` with an `accounts.<accountId>` entry → that
 *    entry's fields override the top-level ones (shallow merge; `allowFrom`
 *    and `selfSenderIds` are REPLACED when present in the override, matching
 *    the bundled-channel convention).
 *  - Non-default `accountId` with NO matching `accounts` entry → top-level
 *    section (preserves the prior behavior so a stray accountId never breaks
 *    resolution).
 *
 * The returned `accountId` is the resolved one (null for the unnamed
 * single-account case so `CliqClientRegistry` keys by `clientId:botId`).
 */
export function readEffectiveCliqSection(
  cfg: OpenClawConfig,
  accountId?: string | null,
): EffectiveCliqSection {
  const top = readTopLevelCliqSection(cfg);
  const acct =
    accountId && accountId !== CLIQ_DEFAULT_ACCOUNT_ID ? accountId : null;
  if (!top || !acct) {
    return { section: top, accountId: acct, isPerAccount: false };
  }
  const accounts = (top as unknown as {
    accounts?: Record<string, CliqChannelConfig | undefined>;
  }).accounts;
  const override = accounts?.[acct];
  if (!override) {
    return { section: top, accountId: acct, isPerAccount: false };
  }
  const merged: CliqChannelConfig = { ...top, ...override };
  return { section: merged, accountId: acct, isPerAccount: true };
}

export function chunkMessage(text: string, limit = MESSAGE_CHAR_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + limit, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n", end);
      if (lastBreak > cursor) end = lastBreak;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export interface SendMessageOptions {
  to: string;
  text: string;
  isDm?: boolean;
}

export interface CliqMediaAttachment {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
}

export interface LoadCliqMediaAttachmentOptions {
  mediaUrl: string;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  mediaAccess?: { readFile?: (filePath: string) => Promise<Buffer> } | null;
  fetchImpl?: typeof fetch;
}

function inferFileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").filter(Boolean).pop();
    if (base) return decodeURIComponent(base);
  } catch {
    // not a URL; fall through to path handling
  }
  const parts = url.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || "attachment";
}

function inferFileNameFromPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || "attachment";
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
  txt: "text/plain", json: "application/json", csv: "text/csv",
  zip: "application/zip", mp3: "audio/mpeg", mp4: "video/mp4",
  webm: "video/webm", mov: "video/quicktime", wav: "audio/wav",
  ogg: "audio/ogg", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function inferMimeFromExt(fileName: string): string | undefined {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  return MIME_BY_EXT[ext];
}

export async function loadCliqMediaAttachment(
  opts: LoadCliqMediaAttachmentOptions,
): Promise<CliqMediaAttachment> {
  const url = opts.mediaUrl;
  const isHttp = /^https?:\/\//i.test(url);
  if (isHttp) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const res = await fetchImpl(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cliq: media fetch failed (${res.status}): ${body}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? undefined;
    const fileName = inferFileNameFromUrl(url);
    const mimeType = ct && ct !== "application/octet-stream" ? ct : (inferMimeFromExt(fileName) ?? ct);
    return { bytes: buf, fileName, mimeType };
  }
  const readFile = opts.mediaReadFile ?? opts.mediaAccess?.readFile;
  if (!readFile) {
    throw new Error(`cliq: cannot read local media "${url}" — no mediaReadFile/mediaAccess.readFile provided`);
  }
  const buffer = await readFile(url);
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  const fileName = inferFileNameFromPath(url);
  const mimeType = inferMimeFromExt(fileName);
  return { bytes, fileName, mimeType };
}

export interface SendMediaMessageOptions {
  to: string;
  text?: string;
  isDm?: boolean;
  attachment: CliqMediaAttachment;
}

/**
 * Options for sending a Cliq bot message with interactive buttons (a Cliq
 * "card"). Buttons are posted alongside an optional text body to the same
 * bot-message (DM) / channelsbyname (channel) endpoints as `sendMessage`.
 * The same scope rules apply: DMs use `ZohoCliq.Webhooks.CREATE`
 * (`client_credentials`), channel posts use `ZohoCliq.Channels.UPDATE`
 * (refresh-token grant — see issue #27).
 */
export interface SendCardMessageOptions {
  to: string;
  text?: string;
  isDm?: boolean;
  /**
   * Action buttons for `modern-inline` / `prompt` cards (and the v2 path).
   * Optional for a `poll` theme card (a poll has no buttons — it uses
   * `pollOptions` instead); a poll send typically passes `buttons: []` or
   * omits this field.
   */
  buttons?: CliqButton[];
  /**
   * v3 Message Card theme to render when `apiVersion === "v3"`. Defaults to
   * `modern-inline`. `prompt` renders a focused quick-reply card (title +
   * 1–5 buttons, no sections); `poll` renders a voting card (title + 2–10
   * options, no buttons — Cliq counts votes natively, no callback to the
   * bot). The v2 path ignores this field (v2 always sends the raw `buttons`
   * array at the top level; a v2 poll degrades to a buttons-only card or
   * plain text).
   */
  theme?: "modern-inline" | "prompt" | "poll";
  /**
   * Voting options for a `poll` theme card (v3 opt-in only; ignored for the
   * other themes and on v2). Each entry is a plain-text string (≤100 chars);
   * the renderer clamps + drops empties and requires ≥2 survivors.
   */
  pollOptions?: string[];
  /**
   * v3 Message Card supporting-content slides (v3 opt-in only; ignored on
   * v2). Attaches validated + clamped `table` / `list` / `label` / `images` /
   * `text` blocks to the top-level `slides` array (compatible with all card
   * themes). Invalid slides are dropped silently (never fail the send). See
   * `V3CardSlideInput` in `src/v3-card.ts`.
   */
  slides?: V3CardSlideInput[];
  /**
   * Header thumbnail URL for a `modern-inline` v3 Message Card (a publicly
   * accessible HTTPS URL shown in the card header next to the title). v3
   * opt-in + `modern-inline` only — ignored on v2 and for `prompt` / `poll`
   * themes. Non-HTTPS / over-length URLs are dropped silently. See
   * `V3CardSectionInput`-family types in `src/v3-card.ts`.
   */
  thumbnail?: string;
  /**
   * In-card labeled field `sections` for a `modern-inline` v3 Message Card
   * body (NOT a top-level slide — `sections` nests inside `card`). v3 opt-in
   * + `modern-inline` only — ignored on v2 and for `prompt` / `poll` themes.
   * Each entry is a `V3CardSectionInput` (`{ title?, fields: [{ title, value }]
   * }`); invalid sections are dropped silently. See `src/v3-card.ts`.
   */
  sections?: V3CardSectionInput[];
}

export interface NormalizedCliqTarget {
  to: string;
  isDm: boolean;
}

/** A raw Zoho Cliq user record as returned by `GET /api/v2/users`. */
export interface CliqUserRecord {
  id?: string;
  user_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  display_name?: string;
  [key: string]: unknown;
}

/** A raw Zoho Cliq channel record as returned by `GET /api/v2/channels`. */
export interface CliqChannelRecord {
  id?: string;
  channel_id?: string;
  chat_id?: string;
  name?: string;
  unique_name?: string;
  display_name?: string;
  [key: string]: unknown;
}

/** A normalized directory entry derived from a raw Cliq user/channel record. */
export interface CliqDirectoryEntry {
  kind: "user" | "group";
  id: string;
  name?: string;
  handle?: string;
  raw?: unknown;
}

/** Pull a string id from a Cliq user record (tolerates `id` / `user_id`). */
function readCliqUserId(rec: CliqUserRecord): string | undefined {
  return rec.id ?? rec.user_id ?? undefined;
}

/** Pull a display name from a Cliq user record (tolerates several fields). */
function readCliqUserName(rec: CliqUserRecord): string | undefined {
  const parts = [
    rec.first_name,
    rec.last_name,
  ].filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length) return parts.join(" ").trim();
  return rec.display_name ?? rec.name ?? rec.email ?? undefined;
}

/** Pull a string id from a Cliq channel record (tolerates `id` / `channel_id`). */
function readCliqChannelId(rec: CliqChannelRecord): string | undefined {
  return rec.id ?? rec.channel_id ?? undefined;
}

/** Pull a display name from a Cliq channel record. */
function readCliqChannelName(rec: CliqChannelRecord): string | undefined {
  return rec.display_name ?? rec.name ?? rec.unique_name ?? undefined;
}

/**
 * Pull a chat id (`CT_xxx`) from a Cliq channel record. The channelsbyname
 * GET returns the channel as a top-level object OR wrapped under a
 * `channel` key (varies by API version); we tolerate both, plus the
 * `id` / `channel_id` / `chat_id` field-name variance.
 */
function readCliqChannelChatId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  const rec = (obj.channel && typeof obj.channel === "object"
    ? (obj.channel as CliqChannelRecord)
    : (obj as CliqChannelRecord));
  return rec.chat_id ?? rec.id ?? rec.channel_id ?? undefined;
}

/** A normalized reference to a chat message (the editable id pair). */
export interface CliqChatMessageRef {
  messageId: string;
  chatId: string;
  text?: string;
}

/**
 * Parse a `GET /api/v2/chats/{chatId}/messages` response into a list of
 * message refs. The response shape is `{ messages: [...] }` (or a bare
 * array in some API versions); each entry is parsed defensively for
 * `message_id` / `id` and `chat_id`, plus an optional `text` (used to
 * disambiguate when the message id alone does not match). Records missing
 * a resolvable id are skipped, never thrown on.
 */
function parseCliqChatMessages(data: unknown): CliqChatMessageRef[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  const list = obj.messages ?? obj.data ?? data;
  if (!Array.isArray(list)) return [];
  const refs: CliqChatMessageRef[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const messageId =
      typeof rec.message_id === "string" ? rec.message_id
        : typeof rec.id === "string" ? rec.id
        : undefined;
    const chatId =
      typeof rec.chat_id === "string" ? rec.chat_id
        : typeof rec.chatId === "string" ? rec.chatId
        : undefined;
    if (!messageId || !chatId) continue;
    const text = typeof rec.text === "string" ? rec.text : undefined;
    refs.push({ messageId, chatId, text });
  }
  return refs;
}



/**
 * Normalize an OpenClaw route target (`ctx.to`) into a raw Zoho Cliq id plus a
 * DM flag. The inbound path encodes the chat type in the target prefix:
 *   - `cliq:user:<id>` / `cliq:dm:<id>`  → DM, deliver via `userids` to /bots/{botId}/message
 *   - `cliq:chat:<id>`                   → group/channel, deliver via channelsbyname
 *   - `cliq:channel:<uniqueName>`        → group/channel, deliver via channelsbyname
 * The `to` for a non-DM target MUST be the channel unique name (the
 * channelsbyname endpoint keys off it in the URL path); a bare chat id is
 * only a fallback when the inbound payload carried no unique name. Targets
 * without the `cliq:` prefix are treated as group/channel ids so raw ids
 * stored in older sessions keep working (defaulting to channelsbyname).
 */
export function normalizeCliqRouteTarget(to: string): NormalizedCliqTarget {
  if (!to) return { to, isDm: false };
  const m = /^cliq:([a-z]+):(.+)$/i.exec(to);
  if (!m) return { to, isDm: false };
  const kind = m[1].toLowerCase();
  const id = m[2];
  if (kind === "user" || kind === "dm") {
    return { to: id, isDm: true };
  }
  return { to: id, isDm: false };
}

/**
 * Parse a Cliq bot-message / chat-message API response into a message ref.
 *
 * The bot-message send response is inconsistent: a top-level `{ id }` for
 * channel posts, or a nested `{ message_details: { "<userId>": { chat_id,
 * message_id } } }` for bot DMs. The chat-message edit response echoes
 * neither reliably. We parse defensively, extracting `messageId` (from
 * `id`, `message_id`, or `message_details[<any>].message_id`) and `chatId`
 * (from `message_details[<any>].chat_id`), never throwing on a malformed
 * body — the caller treats a missing id as "send succeeded but no ref".
 */
function parseCliqMessageRef(body: string): { messageId?: string; chatId?: string } {
  if (!body) return {};
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  let obj = data as Record<string, unknown>;
  // v3 responses may wrap the payload under a top-level `data` object (e.g.
  // `POST /api/v3/bots/{botId}/messages` with `sync_message: true` returns
  // `{ data: { message_id, chat_id } }`). Unwrap it so the same parser covers
  // v2 + v3 shapes.
  const wrapped = obj.data;
  if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
    obj = wrapped as Record<string, unknown>;
  }
  const topId = typeof obj.id === "string" ? obj.id : undefined;
  const topMessageId =
    typeof obj.message_id === "string" ? obj.message_id : undefined;
  const topChatId =
    typeof obj.chat_id === "string" ? obj.chat_id : undefined;
  let nestedChatId: string | undefined;
  let nestedMessageId: string | undefined;
  const details = obj.message_details;
  if (details && typeof details === "object") {
    for (const value of Object.values(details as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const entry = value as Record<string, unknown>;
        if (typeof entry.chat_id === "string") nestedChatId = entry.chat_id;
        if (typeof entry.message_id === "string") nestedMessageId = entry.message_id;
      }
    }
  }
  return {
    messageId: topMessageId ?? nestedMessageId ?? topId,
    chatId: nestedChatId ?? topChatId,
  };
}

/**
 * Parse a v3 "Delete multiple messages" 2xx response body into a boolean
 * success for a single-message delete. The v3 response shape is
 * `{ type: "message.delete_result", data: [{ id, status, error? }] }` where
 * `status` is `"success"` or `"failed"`. For a 1-id delete the response
 * carries exactly one entry; success is `data[0].status === "success"`. A
 * 2xx with no/empty/unmatched data is treated as a logical failure (returns
 * `false`) so the caller degrades gracefully. Never throws on a malformed
 * body — `withSendRetry` already handled the non-2xx classification path.
 */
function parseCliqDeleteResult(body: string): boolean {
  if (!body) return false;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return false;
  }
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  const arr = obj.data;
  if (!Array.isArray(arr) || arr.length === 0) return false;
  // For a single-message delete the response carries exactly one entry.
  // Accept success when the first (and presumably only) entry reports it;
  // do not scan for an arbitrary success (we sent exactly one id, so there
  // is exactly one result — a "failed" entry means OUR delete failed).
  const first = arr[0];
  if (first && typeof first === "object") {
    return (first as Record<string, unknown>).status === "success";
  }
  return false;
}

export class CliqClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly retryOptions: Required<RetryOptions>;
  private readonly logger: CliqLogger;
  /**
   * Cache of resolved channel unique name → chat id (`CT_xxx`). The mapping
   * is stable for the lifetime of a channel, so it is cached per client
   * (and therefore per account) to avoid a `GET /channelsbyname/{name}`
   * round-trip on every group/channel send. Used by live-edit streaming to
   * address the chat-message edit API with a valid chat id instead of the
   * channel unique name (which the edit endpoint rejects).
   */
  private readonly channelChatIdCache = new Map<string, string>();

  /**
   * Cache key under which the user-context (refresh-token) access token is
   * stored. A refresh-token access token is NOT scoped per-request — it
   * carries whatever scopes were consented at the authorization-code grant
   * — so it is cached as a single shared entry, not one per scope.
   */
  private static readonly REFRESH_TOKEN_KEY = "__refresh_token__";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly botId: string,
    private apiBase = EU_API_BASE,
    private readonly oauthBase = EU_OAUTH_BASE,
    retryOptions?: RetryOptions,
    logger?: CliqLogger,
    private readonly refreshToken?: string,
    private readonly apiVersion: CliqApiVersion = "v2",
  ) {
    const base = retryOptions ?? {};
    this.retryOptions = {
      maxAttempts: base.maxAttempts ?? 3,
      baseDelayMs: base.baseDelayMs ?? 500,
      maxDelayMs: base.maxDelayMs ?? 8_000,
      sleep: base.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      random: base.random ?? Math.random,
    };
    // Fall back to the module-level default logger (console, or the gateway
    // `api.logger` injected via `setCliqDefaultLogger` at registration). A
    // caller-supplied logger always wins so tests can capture exact calls.
    this.logger = logger ?? getCliqDefaultLogger();
  }

  /** Current REST API base (may change after a token response `api_domain`
   *  self-correction — see `maybeCorrectApiBaseFromApiDomain`). */
  getApiBase(): string {
    return this.apiBase;
  }

  /**
   * Inspect the `api_domain` Zoho returns in a token response and, when it
   * indicates a different region than the currently configured `apiBase`,
   * switch `apiBase` to the matching Cliq base (`https://cliq.zoho.<tld>`,
   * NEVER the raw `zohoapis` host) and log a single warning. `oauthBase` is
   * left unchanged — the first token is fetched from `oauthBase`, so a wrong
   * `oauthBase` fails before any `api_domain` is returned and cannot be
   * self-healed by this method (the setup-wizard DC prompt handles that).
   *
   * This is best-effort: when `api_domain` is missing or does not match a
   * known region, `apiBase` is left untouched.
   */
  private maybeCorrectApiBaseFromApiDomain(apiDomain: string | undefined | null): void {
    if (!apiDomain) return;
    const detected = findCliqDataCenterByApiDomain(apiDomain);
    if (!detected) return;
    const current = findCliqDataCenterByApiBase(this.apiBase);
    if (current && current.id === detected.id) return;
    const previous = this.apiBase;
    this.apiBase = detected.apiBase;
    this.logger.warn?.(
      `[cliq] oauth: api_domain (${apiDomain}) indicates region "${detected.id}" — corrected apiBase from ${previous} to ${detected.apiBase}. Set apiBase (and oauthBase) explicitly in config to suppress this.`,
    );
  }

  async getAccessToken(scope = "ZohoCliq.Webhooks.CREATE"): Promise<string> {
    const now = Date.now();
    const cached = this.tokens.get(scope);
    if (cached && now < cached.expiresAt - 60_000) {
      return cached.token;
    }
    const url = new URL(`${this.oauthBase}/oauth/v2/token`);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    url.searchParams.set("scope", scope);
    this.logger.debug?.(`[cliq] oauth: requesting access token (scope=${scope})`);
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error?.(
        `[cliq] oauth: token request failed status=${res.status} scope=${scope} body=${truncateForLog(body)}`,
      );
      throw new Error(
        `cliq: OAuth token request failed (${res.status}): ${body}${appendDcHint(body)}`,
      );
    }
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      api_domain?: string;
    };
    if (!data.access_token) {
      this.logger.error?.(`[cliq] oauth: response missing access_token (scope=${scope})`);
      throw new Error("cliq: OAuth response did not include access_token");
    }
    this.maybeCorrectApiBaseFromApiDomain(data.api_domain);
    this.tokens.set(scope, {
      token: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    });
    this.logger.debug?.(
      `[cliq] oauth: access token acquired (scope=${scope} expires_in=${data.expires_in ?? 3600}s)`,
    );
    return data.access_token;
  }

  /**
   * Mint an access token via the user-context `refresh_token` grant. Used by
   * the outbound paths that require a user-consented token (channel posts
   * via `ZohoCliq.Channels.UPDATE` and message edits via
   * `ZohoCliq.Messages.UPDATE`) — the `client_credentials` grant cannot
   * obtain a usable token for those scopes (Zoho issues a token whose
   * response reports the scope, but the API rejects it with
   * `oauthtoken_scope_invalid`). A refresh-token access token carries all
   * scopes consented at the authorization-code grant, so it is cached as a
   * single shared entry (not per-scope) and reused for both the channel and
   * edit paths. Throws if no `refreshToken` is configured.
   */
  async getRefreshedAccessToken(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error(
        "cliq: no refreshToken configured — channel posts and message edits require a user-context token (see README §3)",
      );
    }
    const now = Date.now();
    const cached = this.tokens.get(CliqClient.REFRESH_TOKEN_KEY);
    if (cached && now < cached.expiresAt - 60_000) {
      return cached.token;
    }
    const url = new URL(`${this.oauthBase}/oauth/v2/token`);
    url.searchParams.set("grant_type", "refresh_token");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    url.searchParams.set("refresh_token", this.refreshToken);
    this.logger.debug?.(`[cliq] oauth: refreshing user-context access token`);
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error?.(
        `[cliq] oauth: refresh token request failed status=${res.status} body=${truncateForLog(body)}`,
      );
      throw new Error(
        `cliq: OAuth refresh token request failed (${res.status}): ${body}${appendDcHint(body)}`,
      );
    }
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      api_domain?: string;
    };
    if (!data.access_token) {
      this.logger.error?.(`[cliq] oauth: refresh response missing access_token`);
      throw new Error("cliq: OAuth refresh response did not include access_token");
    }
    this.maybeCorrectApiBaseFromApiDomain(data.api_domain);
    this.tokens.set(CliqClient.REFRESH_TOKEN_KEY, {
      token: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    });
    this.logger.debug?.(
      `[cliq] oauth: refreshed access token acquired (expires_in=${data.expires_in ?? 3600}s)`,
    );
    return data.access_token;
  }

  /**
   * Resolve the access token for an outbound send/edit. When a
   * `refreshToken` is configured AND the operation requires a user-context
   * scope (channel posts / edits), use the refresh-token grant; otherwise
   * fall back to `client_credentials` (the DM path and the no-refreshToken
   * DM-only setup).
   */
  private resolveOutboundToken(scope: string, needsUserContext: boolean): Promise<string> {
    return needsUserContext && this.refreshToken
      ? this.getRefreshedAccessToken()
      : this.getAccessToken(scope);
  }

  async sendMessage(opts: SendMessageOptions): Promise<{ messageId?: string; chatId?: string }> {
    const isDm = Boolean(opts.isDm);
    // DMs use the bot-message endpoint (scope ZohoCliq.Webhooks.CREATE).
    // Channel posts use the channelsbyname endpoint with the channel unique
    // name in the path and the bot identity as a `bot_unique_name` query
    // param (scope ZohoCliq.Channels.UPDATE). The bot-message endpoint
    // rejects `chatid` ("'chatid' is an extra key in the JSON Object"), so
    // group sends MUST NOT go through /bots/{botId}/message. See issue #26.
    // The Channels.UPDATE scope CANNOT be obtained via client_credentials
    // (Zoho issues a token that reports the scope but rejects it on use with
    // `oauthtoken_scope_invalid`); a user-context refresh token is required
    // for channel posts. See issue #27. When no refreshToken is configured,
    // the channel path falls back to client_credentials (which will fail at
    // the API — i.e. DM-only setups keep working unchanged).
    //
    // v3 channel text post (opt-in via apiVersion==="v3"): the v3 endpoint
    // POST /api/v3/channelsbyname/{name}/messages uses the
    // ZohoCliq.Webhooks.CREATE scope — which client_credentials CAN obtain
    // — so a v3 channel text post does NOT require a refresh token. v3
    // returns 204 No response (no message id); live-edit recovers via the
    // existing resolveChannelChatId + listChatMessages path. v3 has no
    // buttons field (sendCard stays v2).
    //
    // v3 bot DM post (opt-in via apiVersion==="v3"): the v3 "Send a bot
    // message" endpoint POST /api/v3/bots/{botId}/messages also uses the
    // ZohoCliq.Webhooks.CREATE scope (the v3 docs list
    // `ZohoCliq.Webhooks.CREATE,ZohoCliq.BotMessages.CREATE`; we request the
    // former — the one client_credentials can obtain and the existing v2 DM
    // path already uses — and the endpoint accepts it; if a Zoho org requires
    // the additional BotMessages.CREATE scope, keep apiVersion at "v2"). Like
    // v2 DMs it posts AS the bot (sender identity preserved — the bot unique
    // name is in the URL path, NOT a /chats/{chatId}/messages user post). The
    // v3 body uses `user_ids` (comma-separated string) instead of v2's
    // `userids`, and sets `sync_message: true` so the response carries
    // `{ data: { message_id, chat_id } }` (unwrapped by parseCliqMessageRef)
    // — giving live-edit streaming for DMs the message id without the nested
    // `message_details` parse the v2 path needed. The scope/needsUserContext
    // calc below already routes DMs (v2 or v3) to Webhooks.CREATE +
    // client_credentials, so only the URL + payload differ for v3 DMs.
    const useV3Channel = !isDm && this.apiVersion === "v3";
    const useV3Dm = isDm && this.apiVersion === "v3";
    const scope = (isDm || useV3Channel)
      ? "ZohoCliq.Webhooks.CREATE"
      : "ZohoCliq.Channels.UPDATE";
    // v2 channel posts need the user-context refresh token; DMs and v3
    // channel posts work with client_credentials (Webhooks.CREATE).
    const needsUserContext = !isDm && !useV3Channel;
    const token = await this.resolveOutboundToken(scope, needsUserContext);
    const targetKind = isDm ? "dm" : "channel";
    const apiTag = useV3Channel || useV3Dm ? " api=v3" : "";
    let url: string;
    const payload: Record<string, unknown> = { text: opts.text };
    if (isDm && useV3Dm) {
      url = `${this.apiBase}/api/v3/bots/${encodeURIComponent(this.botId)}/messages`;
      // v3 bot-message body: user_ids (comma-separated string) + sync_message
      // so the response includes { data: { message_id, chat_id } }.
      payload.user_ids = opts.to;
      payload.sync_message = true;
    } else if (isDm) {
      url = `${this.apiBase}/api/v2/bots/${encodeURIComponent(this.botId)}/message`;
      payload.userids = opts.to;
    } else if (useV3Channel) {
      url = `${this.apiBase}/api/v3/channelsbyname/${encodeURIComponent(opts.to)}/messages?bot_unique_name=${encodeURIComponent(this.botId)}`;
      // v3 body is { text, reply_to?, sync_message? } — no buttons (Message Cards).
    } else {
      url = `${this.apiBase}/api/v2/channelsbyname/${encodeURIComponent(opts.to)}/message?bot_unique_name=${encodeURIComponent(this.botId)}`;
    }
    this.logger.info?.(
      `[cliq] send: ${targetKind} id=${opts.to} textLen=${opts.text.length}${apiTag}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          const ref = parseCliqMessageRef(body);
          this.logger.info?.(
            `[cliq] send ok: status=${r.status} ${targetKind} id=${opts.to} messageId=${ref.messageId ?? "-"} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] send non-2xx: status=${r.status} ${targetKind} id=${opts.to} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return parseCliqMessageRef(res.body);
  }

  /**
   * Post a media attachment (raw bytes) to a DM or channel via the v2
   * multipart endpoints. This is a v3 DEAD END: v3 message-post endpoints
   * take a JSON `{ text, reply_to?, sync_message? }` body with NO
   * `attachments` field, v3 has no Files API (no byte-upload surface), and
   * the only v3 image option is a Message-Card `images` slide that accepts
   * PUBLIC HTTPS image URLs only (no raw bytes) via the Message-Card channel
   * endpoint — which posts as the authenticated USER (not the bot) and needs
   * the user-context refresh token (`Channels.CREATE`). That path is strictly
   * worse than the v2 multipart path (bot sender identity, raw bytes, any
   * MIME type) for the plugin's media-upload use case, so media posts stay
   * on `/api/v2/...` REGARDLESS of the `apiVersion` opt-in, indefinitely
   * (locked by a regression test in `src/channel.test.ts`).
   */
  async sendMediaMessage(opts: SendMediaMessageOptions): Promise<{ messageId?: string }> {
    const isDm = Boolean(opts.isDm);
    const scope = isDm ? "ZohoCliq.Webhooks.CREATE" : "ZohoCliq.Channels.UPDATE";
    const needsUserContext = !isDm;
    const token = await this.resolveOutboundToken(scope, needsUserContext);
    const form = new FormData();
    if (opts.text) form.set("text", opts.text);
    let url: string;
    if (isDm) {
      url = `${this.apiBase}/api/v2/bots/${encodeURIComponent(this.botId)}/message`;
      form.set("userids", opts.to);
    } else {
      // Channel media post: channelsbyname endpoint (see sendMessage/issue #26).
      url = `${this.apiBase}/api/v2/channelsbyname/${encodeURIComponent(opts.to)}/message?bot_unique_name=${encodeURIComponent(this.botId)}`;
    }
    const mimeType = opts.attachment.mimeType ?? "application/octet-stream";
    // Copy into a standalone ArrayBuffer so the Blob does not capture a shared
    // Node Buffer pool (which would include unrelated adjacent allocations).
    const standalone = new Uint8Array(opts.attachment.bytes.byteLength);
    standalone.set(opts.attachment.bytes);
    const blob = new Blob([standalone], { type: mimeType });
    form.set("attachments", blob, opts.attachment.fileName);
    const targetKind = opts.isDm ? "dm" : "channel";
    this.logger.info?.(
      `[cliq] send media: ${targetKind} id=${opts.to} fileName=${opts.attachment.fileName} bytes=${opts.attachment.bytes.byteLength}${opts.text ? ` textLen=${opts.text.length}` : ""}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          body: form,
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          const parsed = JSON.parse(body || "{}") as { id?: string };
          this.logger.info?.(
            `[cliq] send media ok: status=${r.status} ${targetKind} id=${opts.to} messageId=${parsed.id ?? "-"} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] send media non-2xx: status=${r.status} ${targetKind} id=${opts.to} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    const data = JSON.parse(res.body || "{}") as { id?: string };
    return { messageId: data.id };
  }

  /**
   * Send a Cliq bot message with interactive buttons (a Cliq "card"). Posts
   * `{ text?, buttons }` to the same DM / channel endpoints as `sendMessage`.
   * The text (when present) is converted to Cliq-native formatting by the
   * caller; this method posts it verbatim. The `buttons` array is sent as
   * the Cliq bot-message `buttons` field. Same scope/retry/logging contract
   * as `sendMessage`; the log line records the button count (never button
   * contents).
   *
   * v3 opt-in (issue #59): when `apiVersion === "v3"` AND the send is a
   * **channel** (non-DM) post, the card routes through the v3 Message Card
   * endpoint `POST /api/v3/channels/{name}/message` (note: `channels`, not
   * `channelsbyname`, and singular `message`) with scope
   * `ZohoCliq.Channels.CREATE` and a Message Card body (theme selected by
   * `opts.theme`, default `modern-inline`; `prompt` renders a focused
   * quick-reply card) rendered by
   * `cliqCardToV3MessageCard`. When `apiVersion === "v3"` AND the send is a
   * **DM**, the card routes through the v3 "Send a bot message" endpoint
   * `POST /api/v3/bots/{botId}/messages` (the SAME endpoint the v3 DM text
   * post uses) with scope `ZohoCliq.Webhooks.CREATE` (client_credentials, NO
   * refresh token required) and the rendered Message Card in the `card`
   * field — the v3 bot-message endpoint accepts a top-level `card` object
   * directly and posts AS THE BOT (sender identity preserved, unlike
   * `POST /api/v3/chats/{chatId}/messages` which posts as the authenticated
   * user), so no chat-id resolution is needed (it addresses recipients via
   * `user_ids`, same as the v3 DM text post). When the v3 renderer yields no
   * payload (no text AND all buttons dropped), the send falls back to the v2
   * path. For v3 channel cards the docs do not document a `bot_unique_name`
   * query param, so a v3 channel card posts AS THE AUTHENTICATED USER (the
   * OAuth client owner), not as the bot — a behavior difference from the v2
   * channel card path; users who need bot sender identity for channel cards
   * stay on `apiVersion: "v2"`.
   */
  async sendCard(opts: SendCardMessageOptions): Promise<{ messageId?: string; chatId?: string }> {
    const isDm = Boolean(opts.isDm);
    // v3 Message Card paths: channel (non-DM) via the v3 Message Card
    // endpoint, DM via the v3 bot-message endpoint's `card` field.
    if (this.apiVersion === "v3") {
      if (isDm) {
        const v3 = await this.trySendCardV3Dm(opts);
        if (v3.handled) return v3.result!;
      } else {
        const v3 = await this.trySendCardV3Channel(opts);
        if (v3.handled) return v3.result!;
      }
    }
    const scope = isDm ? "ZohoCliq.Webhooks.CREATE" : "ZohoCliq.Channels.UPDATE";
    const needsUserContext = !isDm;
    const token = await this.resolveOutboundToken(scope, needsUserContext);
    const targetKind = isDm ? "dm" : "channel";
    const buttons = opts.buttons ?? [];
    const payload: Record<string, unknown> = {};
    if (opts.text) payload.text = opts.text;
    if (buttons.length > 0) payload.buttons = buttons;
    let url: string;
    if (isDm) {
      url = `${this.apiBase}/api/v2/bots/${encodeURIComponent(this.botId)}/message`;
      payload.userids = opts.to;
    } else {
      url = `${this.apiBase}/api/v2/channelsbyname/${encodeURIComponent(opts.to)}/message?bot_unique_name=${encodeURIComponent(this.botId)}`;
    }
    this.logger.info?.(
      `[cliq] send card: ${targetKind} id=${opts.to} buttons=${buttons.length}${opts.text ? ` textLen=${opts.text.length}` : ""}${opts.theme ? ` theme=${opts.theme}` : ""}${opts.pollOptions ? ` pollOptions=${opts.pollOptions.length}` : ""}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          const ref = parseCliqMessageRef(body);
          this.logger.info?.(
            `[cliq] send card ok: status=${r.status} ${targetKind} id=${opts.to} messageId=${ref.messageId ?? "-"} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] send card non-2xx: status=${r.status} ${targetKind} id=${opts.to} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return parseCliqMessageRef(res.body);
  }

  /**
   * v3 Message Card channel send — the channel card/button post path under
   * `apiVersion: "v3"` (issue #59). Renders the v2 `CliqButton` card into a
   * v3 `modern-inline` Message Card body and POSTs it to
   * `POST /api/v3/channels/{CHANNEL_UNIQUE_NAME}/message` (note: `channels`,
   * NOT `channelsbyname`, and singular `message`) with scope
   * `ZohoCliq.Channels.CREATE` — a different path AND scope from both the v2
   * channel card endpoint and the v3 channel *text* post endpoint. Routes
   * through the refresh-token grant (`Channels.CREATE` is a user-context
   * scope, same constraint as `Channels.UPDATE` — see issue #27) and throws
   * when no `refreshToken` is configured (matching the v2 channel card
   * contract; the caller treats a throw as a failed send).
   *
   * The v3 Message Card docs do not document a `bot_unique_name` query param,
   * so the card posts AS THE AUTHENTICATED USER (the OAuth client owner),
   * not as the bot — a behavior difference from the v2 channel card path.
   *
   * Returns `{ handled: false }` when the v3 renderer yields no payload (no
   * text AND all buttons dropped during conversion) so the caller falls back
   * to the v2 path. The 2xx response is `{ data: { id, card: {...} } }`
   * (unwrapped by `parseCliqMessageRef`, which already handles the v3
   * top-level `data` wrapper); a non-2xx is classified + retried by
   * `withSendRetry` (transient 429/5xx retried with backoff, 4xx fatal →
   * throws `CliqSendError`), matching the v2 send contract.
   *
   * Ref: <https://www.zoho.com/cliq/help/restapi/v3/messagecards/#post-a-message-card-to-a-channel>.
   */
  private async trySendCardV3Channel(
    opts: SendCardMessageOptions,
  ): Promise<{
    handled: boolean;
    result?: { messageId?: string; chatId?: string };
  }> {
    const payload = cliqCardToV3MessageCard(
      { text: opts.text, buttons: opts.buttons, theme: opts.theme, pollOptions: opts.pollOptions, slides: opts.slides, thumbnail: opts.thumbnail, sections: opts.sections },
      { botId: this.botId },
    );
    if (!payload) return { handled: false };
    const token = await this.resolveOutboundToken(
      "ZohoCliq.Channels.CREATE",
      true,
    );
    const url = `${this.apiBase}/api/v3/channels/${encodeURIComponent(opts.to)}/message`;
    this.logger.info?.(
      `[cliq] send card: channel id=${opts.to} buttons=${(opts.buttons ?? []).length}${opts.text ? ` textLen=${opts.text.length}` : ""}${opts.theme ? ` theme=${opts.theme}` : ""}${opts.pollOptions ? ` pollOptions=${opts.pollOptions.length}` : ""}${opts.slides ? ` slides=${opts.slides.length}` : ""} api=v3`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          const ref = parseCliqMessageRef(body);
          this.logger.info?.(
            `[cliq] send card ok: status=${r.status} channel id=${opts.to} messageId=${ref.messageId ?? "-"} attempt=${attempt} api=v3`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] send card non-2xx: status=${r.status} channel id=${opts.to} attempt=${attempt} body=${truncateForLog(body)} api=v3`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return { handled: true, result: parseCliqMessageRef(res.body) };
  }

  /**
   * v3 Message Card DM send — the DM card/button post path under
   * `apiVersion: "v3"`. Renders the v2 `CliqButton` card into a v3
   * `modern-inline` Message Card body and POSTs it to the v3 "Send a bot
   * message" endpoint `POST /api/v3/bots/{BOT_UNIQUE_NAME}/messages` (the
   * SAME endpoint the v3 DM text post uses) with scope
   * `ZohoCliq.Webhooks.CREATE` (client_credentials — NO refresh token
   * required, unlike the v3 channel card path). The v3 bot-message endpoint
   * accepts a top-level `card` object directly and posts AS THE BOT (sender
   * identity preserved — the bot unique name is in the URL path, NOT a
   * `POST /api/v3/chats/{chatId}/messages` user post), so NO chat-id
   * resolution is needed: recipients are addressed via `user_ids` (comma-
   * separated string), exactly like the v3 DM text post. `sync_message: true`
   * is set so the response carries `{ data: { message_id, chat_id } }`
   * (unwrapped by `parseCliqMessageRef`), giving live-edit streaming for DM
   * cards the message id without the nested `message_details` parse the v2
   * path needed.
   *
   * Returns `{ handled: false }` when the v3 renderer yields no payload (no
   * text AND all buttons dropped during conversion) so the caller falls back
   * to the v2 path. The 2xx response is unwrapped by `parseCliqMessageRef`
   * (which already handles the v3 top-level `data` wrapper); a non-2xx is
   * classified + retried by `withSendRetry` (transient 429/5xx retried with
   * backoff, 4xx fatal → throws `CliqSendError`), matching the v2 send
   * contract.
   *
   * Ref: <https://www.zoho.com/cliq/help/restapi/v3/bots/#send-a-bot-message>.
   */
  private async trySendCardV3Dm(
    opts: SendCardMessageOptions,
  ): Promise<{
    handled: boolean;
    result?: { messageId?: string; chatId?: string };
  }> {
    const card = cliqCardToV3MessageCard(
      { text: opts.text, buttons: opts.buttons, theme: opts.theme, pollOptions: opts.pollOptions, slides: opts.slides, thumbnail: opts.thumbnail, sections: opts.sections },
      { botId: this.botId },
    );
    if (!card) return { handled: false };
    const token = await this.resolveOutboundToken(
      "ZohoCliq.Webhooks.CREATE",
      false,
    );
    const url = `${this.apiBase}/api/v3/bots/${encodeURIComponent(this.botId)}/messages`;
    const payload: Record<string, unknown> = {
      ...card,
      user_ids: opts.to,
      sync_message: true,
    };
    this.logger.info?.(
      `[cliq] send card: dm id=${opts.to} buttons=${(opts.buttons ?? []).length}${opts.text ? ` textLen=${opts.text.length}` : ""}${opts.theme ? ` theme=${opts.theme}` : ""}${opts.pollOptions ? ` pollOptions=${opts.pollOptions.length}` : ""}${opts.slides ? ` slides=${opts.slides.length}` : ""} api=v3`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          const ref = parseCliqMessageRef(body);
          this.logger.info?.(
            `[cliq] send card ok: status=${r.status} dm id=${opts.to} messageId=${ref.messageId ?? "-"} attempt=${attempt} api=v3`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] send card non-2xx: status=${r.status} dm id=${opts.to} attempt=${attempt} body=${truncateForLog(body)} api=v3`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return { handled: true, result: parseCliqMessageRef(res.body) };
  }

  /**
   * Edit an existing chat message in place via the Cliq chat-messages API:
   * `PUT /api/v2/chats/{chatId}/messages/{messageId}` with body `{ text }`.
   * The text MUST already be in Cliq-native formatting (the caller runs
   * `markdownToCliq`); this method does not re-format. Requires the
   * `ZohoCliq.Messages.UPDATE` scope (minted + cached per-scope, separate
   * from the webhook bot-message token).
   *
   * Used as the building block for live-edit streaming previews and for the
   * future message-action adapter (edit/delete). Carries the same
   * transient/fatal/format classification + retry as `sendMessage`.
   *
   * Returns `{ messageId, chatId }` for symmetry with `sendMessage` (the
   * Cliq edit response does not always echo the id, so we fall back to the
   * caller-supplied ids).
   */
  async editMessage(opts: {
    chatId: string;
    messageId: string;
    text: string;
  }): Promise<{ messageId?: string; chatId?: string }> {
    // The Messages.UPDATE scope cannot be obtained via client_credentials
    // (same oauthtoken_scope_invalid failure as Channels.UPDATE); a
    // user-context refresh token is required for edits. See issue #27.
    const token = await this.resolveOutboundToken(
      "ZohoCliq.Messages.UPDATE",
      true,
    );
    const url = `${this.apiBase}/api/v2/chats/${encodeURIComponent(opts.chatId)}/messages/${encodeURIComponent(opts.messageId)}`;
    this.logger.info?.(
      `[cliq] edit: chatId=${opts.chatId} messageId=${opts.messageId} textLen=${opts.text.length}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: opts.text }),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] edit ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] edit non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    const parsed = parseCliqMessageRef(res.body);
    return {
      messageId: parsed.messageId ?? opts.messageId,
      chatId: parsed.chatId ?? opts.chatId,
    };
  }

  /**
   * Delete an existing chat message via the Cliq chat-messages API:
   * `DELETE /api/v2/chats/{chatId}/messages/{messageId}`. Like `editMessage`,
   * this requires the `ZohoCliq.Messages.UPDATE` scope, which cannot be
   * obtained via `client_credentials` — a user-context refresh token is
   * required (see issue #27). Returns `true` on a 2xx (Cliq returns 204 No
   * Content on success); throws on a non-2xx with the response body for
   * diagnostics. Carries the same transient/fatal retry as `sendMessage`
   * (429/5xx retried with backoff; 4xx fatal).
   */
  async deleteMessage(opts: {
    chatId: string;
    messageId: string;
  }): Promise<boolean> {
    if (this.apiVersion === "v3") {
      return this.deleteMessageV3(opts);
    }
    const token = await this.resolveOutboundToken(
      "ZohoCliq.Messages.UPDATE",
      true,
    );
    const url = `${this.apiBase}/api/v2/chats/${encodeURIComponent(opts.chatId)}/messages/${encodeURIComponent(opts.messageId)}`;
    this.logger.info?.(
      `[cliq] delete: chatId=${opts.chatId} messageId=${opts.messageId}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "DELETE",
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] delete ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] delete non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return res.status >= 200 && res.status < 300;
  }

  /**
   * v3 message delete — the third v3 migration family. v3 Messages has NO
   * single-message delete endpoint; it only ships a bulk "Delete multiple
   * messages" endpoint `DELETE /api/v3/chats/{chatId}/messagess?message_ids=<csv>`
   * (the path's triple-s `messagess` is the published v3 path — see the v3
   * Messages docs — not a typo in this code). A single-message delete is a
   * 1-element delete-multiple call.
   *
   * Scope `ZohoCliq.Messages.DELETE` — a user-context scope the
   * `client_credentials` grant cannot obtain a usable token for (same
   * constraint as `Messages.UPDATE`, `Channels.UPDATE`, `messageactions.CREATE`
   * — see issue #27), so the path routes through the refresh-token grant and
   * throws when no `refreshToken` is configured (same as the v2 delete path).
   *
   * The 2xx response is a per-message result list
   * `{ type: "message.delete_result", data: [{ id, status, error? }] }`
   * where `status` is `"success"` or `"failed"`. For a single-id delete the
   * response carries exactly one entry; success is `data[0].status ===
   * "success"`. A 2xx with no/empty/unmatched data is treated as a logical
   * failure (returns `false`) — the caller (live-edit best-effort cleanup,
   * message-action `delete`) degrades gracefully. A non-2xx is classified +
   * retried by `withSendRetry` (transient 429/5xx retried with backoff;
   * 4xx fatal → throws `CliqSendError`), matching the v2 delete contract.
   *
   * Ref: <https://www.zoho.com/cliq/help/restapi/v3/messages/#delete-multiple-messages>.
   */
  private async deleteMessageV3(opts: {
    chatId: string;
    messageId: string;
  }): Promise<boolean> {
    const token = await this.resolveOutboundToken(
      "ZohoCliq.Messages.DELETE",
      true,
    );
    const url = `${this.apiBase}/api/v3/chats/${encodeURIComponent(opts.chatId)}/messagess?message_ids=${encodeURIComponent(opts.messageId)}`;
    this.logger.info?.(
      `[cliq] delete: chatId=${opts.chatId} messageId=${opts.messageId} api=v3`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "DELETE",
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] delete ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} api=v3`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] delete non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)} api=v3`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return parseCliqDeleteResult(res.body);
  }

  /**
   * Fetch an authenticated JSON document from the Cliq REST API using the
   * user-context (refresh-token) access token. Used by endpoints that need a
   * user-consented scope the `client_credentials` grant cannot obtain
   * (e.g. reading chat messages — `ZohoCliq.Messages.UPDATE` / channel
   * context). Throws if no `refreshToken` is configured (the refresh-token
   * grant is the only way to mint a usable token for these endpoints).
   */
  private async getJsonUserContext(path: string): Promise<unknown> {
    const token = await this.getRefreshedAccessToken();
    const url = `${this.apiBase}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cliq: GET ${path} failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  /**
   * Resolve a Zoho Cliq channel unique name (the handle used in the
   * channelsbyname send URL) to its underlying chat id (`CT_xxx`) — the id
   * the chat-message edit API (`PUT /api/v2/chats/{chatId}/messages/...`)
   * requires. A channel POST's bot-message send response returns only a
   * top-level `{ id }` (the message id), NOT the chat id, so live-edit
   * streaming for group/channel posts must resolve the chat id separately.
   *
   * The mapping is cached per client (per account) — a channel's chat id is
   * stable. Returns `undefined` when the channel cannot be resolved (not
   * found, API error, or the record carries no resolvable id); the caller
   * (live-edit) treats that as "no editable chat id" and degrades to a new
   * message per block. Never throws so a directory/resolve failure cannot
   * break an agent turn.
   */
  async resolveChannelChatId(channelUniqueName: string): Promise<string | undefined> {
    const key = channelUniqueName;
    const cached = this.channelChatIdCache.get(key);
    if (cached) return cached;
    const path = `/api/v2/channelsbyname/${encodeURIComponent(channelUniqueName)}`;
    let data: unknown;
    try {
      data = await this.getJson(path, "ZohoCliq.Channels.READ");
    } catch (err) {
      this.logger.warn?.(
        `[cliq] resolveChannelChatId: GET ${path} failed (${String(err)})`,
      );
      return undefined;
    }
    const chatId = readCliqChannelChatId(data);
    if (chatId) {
      this.channelChatIdCache.set(key, chatId);
      this.logger.debug?.(
        `[cliq] resolveChannelChatId: ${channelUniqueName} -> ${chatId}`,
      );
    } else {
      this.logger.warn?.(
        `[cliq] resolveChannelChatId: no chat id in record for ${channelUniqueName}`,
      );
    }
    return chatId;
  }

  /**
   * Fetch the most recent messages of a chat (`GET /api/v2/chats/{chatId}/messages`).
   * Used by live-edit streaming to recover the editable chat-message ref for a
   * just-sent channel post when the direct chat-id edit fails — the bot-message
   * send `id` is not always the same as the chat-message `message_id` the edit
   * API expects, so listing recent messages and matching by id/text recovers
   * the canonical `{ chat_id, message_id }` (the bernesto reference pattern).
   *
   * Requires a user-context refresh token (chat-message reads need a
   * user-consented scope the `client_credentials` grant cannot obtain, same
   * constraint as channel posts + edits). Throws if no refresh token is
   * configured or the API rejects the request; the live-edit caller wraps the
   * call in try/catch and degrades to a new message on failure.
   */
  async listChatMessages(
    chatId: string,
    opts: { limit?: number } = {},
  ): Promise<CliqChatMessageRef[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const path = `/api/v2/chats/${encodeURIComponent(chatId)}/messages?from=0&limit=${limit}`;
    const data = await this.getJsonUserContext(path);
    return parseCliqChatMessages(data);
  }

  /**
   * Download a file attachment by its Cliq file id via
   * `GET /api/v2/files/{FILE_ID}` (scope `ZohoCliq.Attachments.READ`).
   * Used by the inbound path to fetch images / files / voice a user sent so
   * they can be handed to the agent. Whether `client_credentials` can obtain
   * a usable token for `Attachments.READ` is not documented; to be safe the
   * path routes through the refresh-token grant when one is configured (same
   * pattern as channel posts / edits / reactions) and falls back to
   * `client_credentials` otherwise (DM-only setups keep working — the
   * download will fail at the API and the inbound path degrades to no media
   * for that attachment rather than breaking the turn). Returns the raw
   * bytes + the response `Content-Type`.
   */
  async downloadAttachment(fileId: string): Promise<{ bytes: Uint8Array; contentType?: string }> {
    const path = `/api/v2/files/${encodeURIComponent(fileId)}`;
    const token = await this.resolveOutboundToken(
      "ZohoCliq.Attachments.READ",
      Boolean(this.refreshToken),
    );
    const url = `${this.apiBase}${path}`;
    this.logger.info?.(`[cliq] download attachment: fileId=${fileId}`);
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.warn?.(
        `[cliq] download attachment non-2xx: status=${res.status} fileId=${fileId} body=${truncateForLog(body)}`,
      );
      throw new Error(`cliq: download attachment (${fileId}) failed (${res.status}): ${body}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? undefined;
    this.logger.debug?.(
      `[cliq] download attachment ok: fileId=${fileId} bytes=${buf.byteLength} ct=${ct ?? "-"}`,
    );
    return { bytes: buf, contentType: ct };
  }

  /**
   * Add a reaction (emoji) to a chat message via the Cliq reactions API:
   * `POST /api/v2/chats/{chatId}/messages/{messageId}/reactions` with body
   * `{ emoji_code }`. Requires the `ZohoCliq.messageactions.CREATE` scope
   * (a user-context scope the `client_credentials` grant cannot obtain a
   * usable token for — same constraint as channel posts + edits, see issue
   * #27), so the path routes through the refresh-token grant when one is
   * configured and falls back to `client_credentials` otherwise (which will
   * fail at the API — DM-only setups keep working). Returns `true` on 2xx.
   *
   * `emoji` may be a Zomoji shortcode (e.g. `:smile:`) or a unicode emoji
   * character (e.g. `😄`); both are accepted by the Cliq API verbatim.
   */
  async addMessageReaction(opts: {
    chatId: string;
    messageId: string;
    emoji: string;
  }): Promise<boolean> {
    const token = await this.resolveOutboundToken(
      "ZohoCliq.messageactions.CREATE",
      true,
    );
    const url = `${this.apiBase}/api/v2/chats/${encodeURIComponent(opts.chatId)}/messages/${encodeURIComponent(opts.messageId)}/reactions`;
    this.logger.info?.(
      `[cliq] react add: chatId=${opts.chatId} messageId=${opts.messageId}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ emoji_code: opts.emoji }),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] react add ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] react add non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return res.status >= 200 && res.status < 300;
  }

  /**
   * Remove a reaction (emoji) from a chat message via the Cliq reactions
   * API: `DELETE /api/v2/chats/{chatId}/messages/{messageId}/reactions` with
   * body `{ emoji_code }`. Like `addMessageReaction`, this requires the
   * `ZohoCliq.messageactions.CREATE` scope (the delete endpoint reuses the
   * CREATE scope per the Cliq REST docs) and a user-context refresh token.
   * Returns `true` on 2xx.
   */
  async removeMessageReaction(opts: {
    chatId: string;
    messageId: string;
    emoji: string;
  }): Promise<boolean> {
    const token = await this.resolveOutboundToken(
      "ZohoCliq.messageactions.CREATE",
      true,
    );
    const url = `${this.apiBase}/api/v2/chats/${encodeURIComponent(opts.chatId)}/messages/${encodeURIComponent(opts.messageId)}/reactions`;
    this.logger.info?.(
      `[cliq] react remove: chatId=${opts.chatId} messageId=${opts.messageId}`,
    );
    let attempt = 0;
    const res = await withSendRetry(
      async () => {
        attempt++;
        const r = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ emoji_code: opts.emoji }),
        });
        const body = await r.text().catch(() => "");
        if (r.ok) {
          this.logger.info?.(
            `[cliq] react remove ok: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt}`,
          );
        } else {
          this.logger.warn?.(
            `[cliq] react remove non-2xx: status=${r.status} chatId=${opts.chatId} messageId=${opts.messageId} attempt=${attempt} body=${truncateForLog(body)}`,
          );
        }
        return { status: r.status, body, headers: r.headers };
      },
      this.retryOptions,
    );
    return res.status >= 200 && res.status < 300;
  }

  /**
   * Fetch an authenticated JSON document from the Cliq REST API. Used by the
   * directory listing endpoints (`/api/v2/users`, `/api/v2/channels`) which
   * are read-only GETs scoped to `ZohoCliq.Users.READ` / `ZohoCliq.Channels.READ`.
   * Throws on a non-2xx with the response body for diagnostics.
   *
   * v3 dead end: v3 has no org-user / channel directory (`GET /api/v3/chats`
   * returns only chats the bot already has, a semantic change), so these paths
   * stay on `/api/v2/...` indefinitely regardless of `apiVersion` — locked by
   * a regression test in `src/directory.test.ts`.
   */
  private async getJson(path: string, scope: string): Promise<unknown> {
    const token = await this.getAccessToken(scope);
    const url = `${this.apiBase}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`cliq: GET ${path} failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  /**
   * List Zoho Cliq users (organization peers) for the directory. Paginates
   * via the v3 `next_token` cursor when the v2 response carries one (v2 used
   * `next_token` as one of its six pagination tokens), falling back to
   * `from`/`limit` offset pagination otherwise — so the directory is
   * forward-compatible with v3's standardized `next_token` model even though
   * the `/users` path stays v2 (v3 has no org-directory equivalent). Cliq's
   * max page size is 200; pages are fetched up to `maxItems`. The raw record
   * is kept on `raw` for callers that need extra fields. Never throws on a
   * malformed record — it is skipped.
   */
  async listUsers(maxItems = 500): Promise<CliqDirectoryEntry[]> {
    const recs = await paginateList<CliqUserRecord>(
      async ({ nextToken, from, limit }) => {
        const path = nextToken
          ? `/api/v2/users?from=${from}&limit=${limit}&next_token=${encodeURIComponent(nextToken)}`
          : `/api/v2/users?from=${from}&limit=${limit}`;
        const json = (await this.getJson(path, "ZohoCliq.Users.READ")) as {
          users?: CliqUserRecord[];
          next_token?: string;
        } | CliqUserRecord[];
        const items = Array.isArray(json) ? json : (json?.users ?? []);
        const token =
          !Array.isArray(json) && typeof json?.next_token === "string"
            ? json.next_token
            : undefined;
        return { items, nextToken: token };
      },
      { maxItems, pageSize: 200 },
    );
    const entries: CliqDirectoryEntry[] = [];
    for (const rec of recs) {
      const id = readCliqUserId(rec);
      if (!id) continue;
      entries.push({
        kind: "user",
        id,
        name: readCliqUserName(rec),
        raw: rec,
      });
    }
    return entries;
  }

  /**
   * List Zoho Cliq channels (group chats the bot/user can see) for the
   * directory. Paginates like `listUsers` (`next_token` cursor when present,
   * `from`/`limit` offset otherwise). Channel ids become directory entries of
   * kind `group`; `unique_name` (when present) is exposed as the `handle` so
   * routing can target either `cliq:chat:<id>` or
   * `cliq:channel:<unique_name>`.
   */
  async listChannels(maxItems = 500): Promise<CliqDirectoryEntry[]> {
    const recs = await paginateList<CliqChannelRecord>(
      async ({ nextToken, from, limit }) => {
        const path = nextToken
          ? `/api/v2/channels?from=${from}&limit=${limit}&next_token=${encodeURIComponent(nextToken)}`
          : `/api/v2/channels?from=${from}&limit=${limit}`;
        const json = (await this.getJson(path, "ZohoCliq.Channels.READ")) as {
          channels?: CliqChannelRecord[];
          next_token?: string;
        } | CliqChannelRecord[];
        const items = Array.isArray(json) ? json : (json?.channels ?? []);
        const token =
          !Array.isArray(json) && typeof json?.next_token === "string"
            ? json.next_token
            : undefined;
        return { items, nextToken: token };
      },
      { maxItems, pageSize: 200 },
    );
    const entries: CliqDirectoryEntry[] = [];
    for (const rec of recs) {
      const id = readCliqChannelId(rec);
      if (!id) continue;
      entries.push({
        kind: "group",
        id,
        name: readCliqChannelName(rec),
        handle: rec.unique_name ?? undefined,
        raw: rec,
      });
    }
    return entries;
  }
}
