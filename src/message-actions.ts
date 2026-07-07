/**
 * Channel message-action adapter for the shared `message` tool.
 *
 * Lets an agent edit / delete / read its own messages (and explicitly send) on
 * Zoho Cliq through the SDK's unified `message(action=...)` tool surface. The
 * adapter declares which actions Cliq supports, gatekeeps them by what the
 * account is configured to do (channel posts / edits / deletes / reads need a
 * user-context refresh token — see issue #27; DM-only `client_credentials`
 * setups can still `send`), and dispatches `handleAction` calls to the
 * `CliqClient`.
 *
 * chatId resolution: the Cliq chat-message edit/delete/read APIs key off a
 * `chat_id` (`CT_xxx`), NOT off a channel unique name or user id. The agent
 * typically has the `to` route target (a `cliq:channel:<uniqueName>` /
 * `cliq:user:<id>` prefixed string) and a `messageId`. For channels we resolve
 * the chat id once via `CliqClient.resolveChannelChatId` (cached per client);
 * for DMs the agent must supply an explicit `chatId` param (DM chat ids are
 * per-user-pair and cannot be resolved from a bare user id without a prior
 * send). An explicit `chatId` param always wins.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";

import {
  normalizeCliqRouteTarget,
  resolveCliqConfig,
  type ResolvedCliqAccount,
} from "./client.js";
import { markdownToCliq } from "./markdown.js";
import { resolveCliqClient } from "./runtime-api.js";
import {
  presentationToCliqCard,
  simpleButtonsToCliqButtons,
  type CliqButton,
  type PortablePresentation,
} from "./presentation.js";
import type { V3CardSectionInput, V3CardSlideInput } from "./v3-card.js";
import {
  readFormParam,
  renderCliqFormCards,
  type CliqFormInput,
} from "./forms-render.js";

/** Actions Cliq can perform via the shared `message` tool, in priority order. */
const CLIQ_ACTIONS_ALL: readonly ChannelMessageActionName[] = [
  "send",
  "edit",
  "delete",
  "read",
  "react",
];

/**
 * Cliq advertises the portable `presentation` capability on the shared
 * `message` tool: an agent may attach interactive buttons to a `send` via the
 * `buttons` param (an array of `{ label, url?, value? }`) or a full portable
 * `presentation` object. Buttons render natively through the Cliq bot-message
 * `buttons` field (see `CliqClient.sendCard`). The full outbound
 * `renderPresentation` path (agent-emitted presentations on a reply) is a
 * follow-up — today the surface is the explicit `message(action=send,
 * buttons=[...])` tool call, which is the common case (link/callback buttons
 * attached to an agent-sent message).
 */
const CLIQ_MESSAGE_CAPABILITIES = ["presentation"] as const;

/** Actions that need a user-context refresh token (issue #27). */
const CLIQ_ACTIONS_NEEDING_REFRESH_TOKEN: ReadonlySet<ChannelMessageActionName> =
  new Set<ChannelMessageActionName>(["edit", "delete", "read", "react"]);

function resolveAccountSafe(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount | null {
  try {
    return resolveCliqConfig(cfg, accountId ?? null);
  } catch {
    return null;
  }
}

/**
 * Decide which actions an account exposes. `send` is always available on a
 * configured account (DM sends work via `client_credentials`); the others need
 * a refresh token because they route through the chat-messages API
 * (`ZohoCliq.Messages.UPDATE` / `ZohoCliq.Channels.READ`), which
 * `client_credentials` cannot obtain a usable token for (issue #27).
 */
function resolveCliqActions(account: ResolvedCliqAccount): ChannelMessageActionName[] {
  const out: ChannelMessageActionName[] = ["send"];
  if (account.refreshToken) {
    for (const a of CLIQ_ACTIONS_ALL) {
      if (a === "send") continue;
      out.push(a);
    }
  }
  return out;
}

/**
 * Build a discovery result for the shared `message` tool. Returns `null` when
 * the channel is unconfigured (no account resolves) so the core hides the
 * `message` tool entirely for Cliq — matches the Discord pattern.
 */
function describeCliqMessageTool(
  params: ChannelMessageActionDiscoveryContext,
): ChannelMessageToolDiscovery | null {
  const account = resolveAccountSafe(params.cfg, params.accountId);
  if (!account) return null;
  return {
    actions: resolveCliqActions(account),
    capabilities: [...CLIQ_MESSAGE_CAPABILITIES],
    schema: null,
  };
}

function readString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Read a string-array param; non-strings + empty/whitespace entries dropped. */
function readStringArray(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const v = params[key];
  if (!Array.isArray(v)) return [];
  return v
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((s) => s.length > 0);
}

function readNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = params[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return undefined;
}

/**
 * Read a `slides` param (an array of v3 Message Card supporting-content
 * blocks) defensively. Each entry must be an object with a string `type` of
 * `table` / `list` / `label` / `images` / `text`; the per-type data fields
 * are accepted in their agent-friendly shapes (`headers`/`rows`, `items`,
 * `pairs`, `urls`, `text`) and coerced to strings. Non-array / non-object
 * entries and unknown slide types are dropped; the renderer clamps + re-
 * validates each entry (see `normalizeV3Slide`). An empty array yields `[]`.
 */
function readSlidesParam(raw: unknown): V3CardSlideInput[] {
  if (!Array.isArray(raw)) return [];
  const out: V3CardSlideInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const type = typeof rec.type === "string" ? rec.type : "";
    const title = typeof rec.title === "string" ? rec.title : undefined;
    if (type === "table") {
      const headers = Array.isArray(rec.headers)
        ? rec.headers.map((h) => String(h ?? "")).filter((s) => s.length > 0)
        : [];
      const rows = Array.isArray(rec.rows)
        ? rec.rows
            .map((r) =>
              r && typeof r === "object" && !Array.isArray(r)
                ? (r as Record<string, string>)
                : {},
            )
            .map((r) => {
              const o: Record<string, string> = {};
              for (const [k, v] of Object.entries(r)) {
                o[k] = String(v ?? "");
              }
              return o;
            })
        : [];
      if (headers.length === 0) continue;
      out.push({ type: "table", ...(title ? { title } : {}), headers, rows });
    } else if (type === "list") {
      const items = Array.isArray(rec.items)
        ? rec.items.map((i) => String(i ?? ""))
        : [];
      if (items.length === 0) continue;
      out.push({ type: "list", ...(title ? { title } : {}), items });
    } else if (type === "label") {
      const pairs = Array.isArray(rec.pairs)
        ? rec.pairs
            .filter(
              (p): p is Record<string, unknown> =>
                Boolean(p && typeof p === "object" && !Array.isArray(p)),
            )
            .map((p) => ({
              label: String(p.label ?? ""),
              value: String(p.value ?? ""),
            }))
        : [];
      if (pairs.length === 0) continue;
      out.push({ type: "label", ...(title ? { title } : {}), pairs });
    } else if (type === "images") {
      const urls = Array.isArray(rec.urls)
        ? rec.urls.map((u) => String(u ?? ""))
        : [];
      if (urls.length === 0) continue;
      out.push({ type: "images", ...(title ? { title } : {}), urls });
    } else if (type === "text") {
      const text = typeof rec.text === "string" ? rec.text : "";
      if (!text.trim()) continue;
      out.push({ type: "text", ...(title ? { title } : {}), text });
    }
  }
  return out;
}

/**
 * Read a `sections` param (an array of v3 `modern-inline` Message Card in-
 * card labeled field groups) defensively. Each entry must be an object with
 * an optional string `title` and an array `fields` of `{ title, value }`
 * pairs (coerced to strings; entries missing `title` or `value` survive here
 * and are dropped later by the renderer). Non-array / non-object entries
 * are dropped; an empty array yields `[]`. See `normalizeV3Section`.
 */
function readSectionsParam(raw: unknown): V3CardSectionInput[] {
  if (!Array.isArray(raw)) return [];
  const out: V3CardSectionInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title : undefined;
    const fields = Array.isArray(rec.fields)
      ? rec.fields
          .filter(
            (p): p is Record<string, unknown> =>
              Boolean(p && typeof p === "object" && !Array.isArray(p)),
          )
          .map((p) => ({
            title: String(p.title ?? ""),
            value: String(p.value ?? ""),
          }))
      : [];
    if (fields.length === 0) continue;
    out.push({ ...(title ? { title } : {}), fields });
  }
  return out;
}

/**
 * Read a `thumbnail` param (a `modern-inline` Message Card header image
 * URL) defensively. Must be a string; the renderer enforces HTTPS-only +
 * length limits. Returns `undefined` for non-string / empty values.
 */
function readThumbnailParam(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

/** Build a successful tool result with a JSON-shaped detail payload. */
function okResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

/** Build a failure tool result (the agent sees the message and can retry). */
function errorResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: `cliq: ${message}` }],
    details: { status: "failed", error: message },
  };
}

/**
 * Resolve the chat id for an edit/delete/read action. Resolution order:
 *   1. Explicit `chatId` param (agent-supplied) — always wins.
 *   2. `to` route target prefixed `cliq:channel:` / `cliq:chat:` → resolve
 *      the channel unique name → chat id via `CliqClient.resolveChannelChatId`
 *      (cached per client).
 *   3. `to` prefixed `cliq:user:` / `cliq:dm:` → no resolution path (DM chat
 *      ids are per-user-pair); returns `undefined` and the caller surfaces a
 *      "chatId required" error to the agent.
 *   4. Bare `to` with no prefix → treated as a channel unique name (matches
 *      the outbound `normalizeCliqRouteTarget` default).
 *
 * Never throws — a resolution failure becomes an agent-visible error so the
 * model can supply the missing `chatId` and retry.
 */
async function resolveChatIdForAction(
  client: Pick<CliqClientLike, "resolveChannelChatId">,
  params: Record<string, unknown>,
): Promise<string | undefined> {
  const explicit = readString(params, "chatId");
  if (explicit) return explicit;
  const to = readString(params, "to") ?? readString(params, "channelId");
  if (!to) return undefined;
  const target = normalizeCliqRouteTarget(to);
  if (target.isDm) return undefined; // DM chat ids cannot be resolved from a user id
  return (await client.resolveChannelChatId(target.to)) ?? undefined;
}

/** Minimal slice of CliqClient the actions adapter depends on. */
interface CliqClientLike {
  sendMessage(opts: {
    to: string;
    text: string;
    isDm?: boolean;
  }): Promise<{ messageId?: string; chatId?: string }>;
  sendCard(opts: {
    to: string;
    text?: string;
    isDm?: boolean;
    buttons?: CliqButton[];
    theme?: "modern-inline" | "prompt" | "poll";
    pollOptions?: string[];
    slides?: V3CardSlideInput[];
    thumbnail?: string;
    sections?: V3CardSectionInput[];
  }): Promise<{ messageId?: string; chatId?: string }>;
  editMessage(opts: {
    chatId: string;
    messageId: string;
    text: string;
  }): Promise<{ messageId?: string; chatId?: string }>;
  deleteMessage(opts: {
    chatId: string;
    messageId: string;
  }): Promise<boolean>;
  listChatMessages(
    chatId: string,
    opts?: { limit?: number },
  ): Promise<
    { messageId: string; chatId: string; text?: string }[]
  >;
  resolveChannelChatId(channelUniqueName: string): Promise<string | undefined>;
  addMessageReaction(opts: {
    chatId: string;
    messageId: string;
    emoji: string;
  }): Promise<boolean>;
  removeMessageReaction(opts: {
    chatId: string;
    messageId: string;
    emoji: string;
  }): Promise<boolean>;
}

/**
 * Resolve the Cliq buttons to attach to a `send` from the tool params. Two
 * shapes are accepted (a non-empty `buttons` array takes precedence over a
 * `presentation` object):
 *  - `buttons`: an array of `{ label, url?, value? }` (the simple,
 *    agent-friendly shape — see `simpleButtonsToCliqButtons`).
 *  - `presentation`: a portable `MessagePresentation` object
 *    (`{ title?, blocks: [...] }`) — see `presentationToCliqCard`.
 * Returns the converted Cliq buttons (possibly empty) plus the body text
 * derived from the presentation (when a `presentation` carried text/title
 * blocks that are not part of the `message` param).
 */
function resolveSendButtons(params: Record<string, unknown>): {
  buttons: CliqButton[];
  presentationText?: string;
} {
  const rawButtons = params["buttons"];
  if (Array.isArray(rawButtons) && rawButtons.length > 0) {
    return { buttons: simpleButtonsToCliqButtons(rawButtons) };
  }
  const rawPresentation = params["presentation"];
  if (rawPresentation && typeof rawPresentation === "object" && !Array.isArray(rawPresentation)) {
    const card = presentationToCliqCard(rawPresentation as PortablePresentation);
    return {
      buttons: card.buttons ?? [],
      presentationText: card.text,
    };
  }
  return { buttons: [] };
}

/**
 * Render an agent-supplied form definition as one or more Cliq prompt card(s)
 * and post them via `sendCard`. Each `select` field with options becomes a
 * `prompt` card (a button per option; tapping a button posts
 * `<fieldName>: <value>` back to the bot as an inbound message the agent
 * reads as the user's answer). `text` / `number` fields fold into a single
 * `modern-inline` summary card posted first. The optional `message` param
 * prefixes the summary card (or the first prompt card when there is no
 * summary) as additional context. Returns an agent-visible success result
 * listing the number of cards posted; a degenerate form (no viable fields)
 * yields an error so the agent can correct and retry.
 */
async function handleFormSend(
  client: CliqClientLike,
  to: string,
  form: CliqFormInput,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const cards = renderCliqFormCards(form);
  if (cards.length === 0) {
    return errorResult(
      "`form` must define at least one viable field (a `select` with ≥2 options, or a text/number field with a `name`).",
    );
  }
  const message = readString(params, "message");
  const target = normalizeCliqRouteTarget(to);
  // An optional `message` prefixes the first card's text as extra context
  // (e.g. instructions or context for the form).
  if (message) {
    const first = cards[0];
    const prefix = markdownToCliq(message);
    first.text = first.text ? `${prefix}\n\n${first.text}` : prefix;
  }
  const posted: Array<{ messageId?: string; chatId?: string }> = [];
  let lastError: unknown;
  for (const spec of cards) {
    try {
      const result = await client.sendCard({
        to: target.to,
        isDm: target.isDm,
        text: spec.text,
        buttons: spec.buttons ?? [],
        ...(spec.theme ? { theme: spec.theme } : {}),
      });
      posted.push(result);
    } catch (err) {
      lastError = err;
      break;
    }
  }
  if (posted.length === 0) {
    return errorResult(`form send failed: ${String(lastError)}`);
  }
  const last = posted[posted.length - 1];
  const selectCount = cards.filter((c) => c.theme === "prompt").length;
  return okResult(
    `Rendered form to ${cards.length} card(s) (${selectCount} prompt card(s) with buttons) in ${to}${last.messageId ? ` (last messageId=${last.messageId})` : ""}${posted.length < cards.length ? ` — ${cards.length - posted.length} card(s) failed to post` : ""}.`,
    {
      action: "send",
      to,
      form: true,
      cards: cards.length,
      promptCards: selectCount,
      posted: posted.length,
      messageId: last.messageId ?? null,
      chatId: last.chatId ?? null,
      ...(posted.length < cards.length
        ? { failed: cards.length - posted.length }
        : {}),
    },
  );
}

async function handleSend(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const to = readString(params, "to") ?? readString(params, "channelId");
  const message = readString(params, "message");
  if (!to) return errorResult("`to` (channel target) is required for send.");
  // A `form` param switches the send to the form-rendering path: the form
  // definition is rendered as one or more Cliq prompt card(s) (a `prompt`-
  // theme card with a button per select option, plus an optional summary
  // card for text/number fields). This takes precedence over `buttons` /
  // `theme` / `slides` — a form send is a distinct structured-input
  // solicitation, not a plain card post.
  const formInput = readFormParam(params["form"]);
  if (formInput) {
    return handleFormSend(client, to, formInput, params);
  }
  const { buttons, presentationText } = resolveSendButtons(params);
  // Body text: explicit `message` wins; otherwise fall back to text derived
  // from a portable `presentation` (title/text/context blocks). A send with
  // only buttons and no text is allowed (Cliq accepts a buttons-only card).
  const body = message ?? presentationText;
  // `theme: "poll"` + `pollOptions` switches the send to a v3 poll Message
  // Card (voting options, no action buttons). Votes are counted natively by
  // Cliq — nothing is posted back to the bot.
  const theme = readString(params, "theme");
  const pollOptions = readStringArray(params, "pollOptions");
  const isPoll = theme === "poll";
  if (isPoll && pollOptions.length < 2) {
    return errorResult(
      "`pollOptions` (min 2) is required for send with theme=poll.",
    );
  }
  // v3 Message Card supporting-content `slides` (table / list / label /
  // images / text blocks) attach alongside the card for v3 opt-in accounts;
  // ignored on v2. Parsed defensively — invalid slides are dropped by the
  // renderer, never throw.
  const slides = readSlidesParam(params["slides"]);
  // v3 `modern-inline` Message Card in-card fields: a `thumbnail` header
  // image URL + `sections` of labeled key/value field groups. Both are
  // `modern-inline`-only (ignored for `prompt` / `poll` and on v2); parsed
  // defensively — the renderer clamps + drops invalid entries, never throws.
  const thumbnail = readThumbnailParam(params["thumbnail"]);
  const sections = readSectionsParam(params["sections"]);
  if (!body && buttons.length === 0 && !isPoll && slides.length === 0 && sections.length === 0) {
    return errorResult("`message` (text) or `buttons` is required for send.");
  }
  const target = normalizeCliqRouteTarget(to);
  const rich = body ? markdownToCliq(body) : undefined;
  const slidesParam = slides.length > 0 ? slides : undefined;
  const sectionsParam = sections.length > 0 ? sections : undefined;
  const thumbnailParam = thumbnail;
  const cardExtras = {
    ...(slidesParam ? { slides: slidesParam } : {}),
    ...(sectionsParam ? { sections: sectionsParam } : {}),
    ...(thumbnailParam ? { thumbnail: thumbnailParam } : {}),
  };
  try {
    const result = isPoll
      ? await client.sendCard({
          to: target.to,
          isDm: target.isDm,
          text: rich,
          buttons: [],
          theme: "poll",
          pollOptions,
          ...cardExtras,
        })
      : buttons.length > 0
        ? await client.sendCard({
            to: target.to,
            isDm: target.isDm,
            text: rich,
            buttons,
            ...cardExtras,
          })
        : slidesParam || sectionsParam || thumbnailParam
          ? await client.sendCard({
              to: target.to,
              isDm: target.isDm,
              text: rich,
              buttons: [],
              ...cardExtras,
            })
          : await client.sendMessage({
              to: target.to,
              isDm: target.isDm,
              text: rich ?? "",
            });
    return okResult(
      `Sent message to ${to}${result.messageId ? ` (messageId=${result.messageId})` : ""}${isPoll ? ` with ${pollOptions.length} poll option(s)` : buttons.length > 0 ? ` with ${buttons.length} button(s)` : slidesParam ? ` with ${slidesParam.length} slide(s)` : sectionsParam ? ` with ${sectionsParam.length} section(s)` : thumbnailParam ? ` with a thumbnail` : ""}.`,
      {
        action: "send",
        to,
        messageId: result.messageId ?? null,
        chatId: result.chatId ?? null,
        ...(isPoll
          ? { theme: "poll", pollOptions: pollOptions.length }
          : { buttons: buttons.length }),
      },
    );
  } catch (err) {
    return errorResult(`send failed: ${String(err)}`);
  }
}


async function handleEdit(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const messageId = readString(params, "messageId");
  const message = readString(params, "message");
  if (!messageId) return errorResult("`messageId` is required for edit.");
  if (!message) return errorResult("`message` (new text) is required for edit.");
  const chatId = await resolveChatIdForAction(client, params);
  if (!chatId) {
    return errorResult(
      "`chatId` could not be resolved — pass `chatId` explicitly (DM chat ids are per-user-pair and cannot be resolved from a user id).",
    );
  }
  const rich = markdownToCliq(message);
  try {
    const result = await client.editMessage({ chatId, messageId, text: rich });
    return okResult(
      `Edited message ${messageId} in chat ${chatId}.`,
      {
        action: "edit",
        chatId,
        messageId,
        chatIdResolved: result.chatId ?? chatId,
        messageIdResolved: result.messageId ?? messageId,
      },
    );
  } catch (err) {
    return errorResult(`edit failed: ${String(err)}`);
  }
}

async function handleDelete(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const messageId = readString(params, "messageId");
  if (!messageId) return errorResult("`messageId` is required for delete.");
  const chatId = await resolveChatIdForAction(client, params);
  if (!chatId) {
    return errorResult(
      "`chatId` could not be resolved — pass `chatId` explicitly (DM chat ids are per-user-pair and cannot be resolved from a user id).",
    );
  }
  try {
    const ok = await client.deleteMessage({ chatId, messageId });
    if (!ok) {
      return errorResult(
        `delete rejected for message ${messageId} in chat ${chatId}.`,
      );
    }
    return okResult(
      `Deleted message ${messageId} in chat ${chatId}.`,
      { action: "delete", chatId, messageId },
    );
  } catch (err) {
    return errorResult(`delete failed: ${String(err)}`);
  }
}

async function handleRead(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const limit = readNumber(params, "limit");
  const chatId = await resolveChatIdForAction(client, params);
  if (!chatId) {
    return errorResult(
      "`chatId` could not be resolved — pass `chatId` explicitly (DM chat ids are per-user-pair and cannot be resolved from a user id).",
    );
  }
  try {
    const messages = await client.listChatMessages(chatId, {
      limit: limit ?? 50,
    });
    return okResult(
      `Read ${messages.length} message(s) from chat ${chatId}.`,
      {
        action: "read",
        chatId,
        count: messages.length,
        messages: messages.map((m) => ({
          messageId: m.messageId,
          chatId: m.chatId,
          ...(m.text ? { text: m.text } : {}),
        })),
      },
    );
  } catch (err) {
    return errorResult(`read failed: ${String(err)}`);
  }
}

/**
 * Add or remove a reaction (emoji) on a chat message. The agent supplies
 * `messageId` + `emoji` and either an explicit `chatId` or a `to` route
 * target resolvable to a channel chat id (DM chat ids cannot be resolved
 * from a bare user id — same caveat as edit/delete). `op: "remove"` (any
 * case) deletes the bot's reaction; the default adds it. The emoji may be a
 * Zomoji shortcode (`:smile:`) or a unicode character (`😄`).
 */
async function handleReact(
  client: CliqClientLike,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const messageId = readString(params, "messageId");
  const emoji = readString(params, "emoji") ?? readString(params, "reaction");
  if (!messageId) return errorResult("`messageId` is required for react.");
  if (!emoji) return errorResult("`emoji` (e.g. \":smile:\" or \"😄\") is required for react.");
  const chatId = await resolveChatIdForAction(client, params);
  if (!chatId) {
    return errorResult(
      "`chatId` could not be resolved — pass `chatId` explicitly (DM chat ids are per-user-pair and cannot be resolved from a user id).",
    );
  }
  const opRaw = readString(params, "op");
  const op: "add" | "remove" =
    opRaw?.toLowerCase() === "remove" ? "remove" : "add";
  try {
    const ok =
      op === "remove"
        ? await client.removeMessageReaction({ chatId, messageId, emoji })
        : await client.addMessageReaction({ chatId, messageId, emoji });
    if (!ok) {
      return errorResult(
        `react ${op} rejected for message ${messageId} in chat ${chatId}.`,
      );
    }
    return okResult(
      `${op === "remove" ? "Removed" : "Added"} reaction ${emoji} on message ${messageId} in chat ${chatId}.`,
      { action: "react", op, chatId, messageId, emoji },
    );
  } catch (err) {
    return errorResult(`react ${op} failed: ${String(err)}`);
  }
}

/**
 * The Cliq message-action adapter. `handleAction` resolves the account from
 * `ctx.cfg` + `ctx.accountId`, builds the `CliqClient` via the registry (so
 * OAuth tokens are shared across turns), and dispatches to the per-action
 * handler. It never throws — any unexpected error becomes an agent-visible
 * failure result so the model can recover (retry / give up) rather than
 * crashing the tool call.
 */
export const cliqMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeCliqMessageTool,
  supportsAction: ({ action }) =>
    CLIQ_ACTIONS_ALL.includes(action as ChannelMessageActionName),
  resolveExecutionMode: () => "local",
  handleAction: async (ctx: ChannelMessageActionContext) => {
    const account = resolveAccountSafe(ctx.cfg, ctx.accountId);
    if (!account) {
      return errorResult(
        "cliq channel is not configured (missing clientId/clientSecret/botId).",
      );
    }
    const action = ctx.action as ChannelMessageActionName;
    if (
      CLIQ_ACTIONS_NEEDING_REFRESH_TOKEN.has(action) &&
      !account.refreshToken
    ) {
      return errorResult(
        `\`${action}\` requires a user-context refresh token (see README §3); the configured account uses client_credentials only.`,
      );
    }
    const client = resolveCliqClient(account) as unknown as CliqClientLike;
    const params = ctx.params ?? {};
    try {
      switch (action) {
        case "send":
          return await handleSend(client, params);
        case "edit":
          return await handleEdit(client, params);
        case "delete":
        case "unsend":
          return await handleDelete(client, params);
        case "read":
          return await handleRead(client, params);
        case "react":
          return await handleReact(client, params);
        default:
          return errorResult(`unsupported action: ${action}`);
      }
    } catch (err) {
      return errorResult(`${action} failed: ${String(err)}`);
    }
  },
};

/** Exported for tests so the pure helpers can be exercised directly. */
export {
  describeCliqMessageTool,
  resolveCliqActions,
  resolveChatIdForAction,
  resolveSendButtons,
  handleFormSend,
  CLIQ_ACTIONS_ALL,
  CLIQ_MESSAGE_CAPABILITIES,
  type CliqClientLike,
};
