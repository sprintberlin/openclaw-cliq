/**
 * v3 Message Cards renderer — converts the plugin's existing card/button
 * shape (`CliqButton` / rendered-card input) into a v3 Message Card payload
 * per <https://www.zoho.com/cliq/help/restapi/v3/messagecards/>.
 *
 * v3 Message Cards replace the v2 bot-message `buttons` field (which the v3
 * message-post endpoints do not support) with a structured `card` object
 * whose `theme` selects the rendering template. The plugin renders two of
 * the three documented themes:
 *  - `modern-inline` — header (`title`), optional labeled field `sections`,
 *    and action `buttons`. The default; used for agent-emitted
 *    presentations and the `message(action=send, buttons=[...])` tool.
 *  - `prompt` — a focused quick-reply card: `title` + 1–5 action buttons
 *    (no sections). Used for the slash-command quick-reply buttons emitted
 *    by `src/commands.ts` (`/models`, `/model`); `buttons` is REQUIRED for a
 *    prompt (a buttonless prompt is invalid → the renderer returns `null`).
 *  - `poll` (voting options) is not yet rendered.
 * Supporting structured content (tables / lists / label rows / images / text
 * blocks) is attached via the top-level `slides` array that sits alongside
 * `card` in the payload (NOT nested inside it).
 *
 * Button action mapping (v2 → v3):
 *  - v2 `action: "openurl"` + `url` → v3 `{ type: "open.url", data: { web: url } }`
 *    (opens `url` in the user's browser).
 *  - v2 `action: "invoke"` + `data` (a slash command / message text the
 *    Deluge Message Handler receives as an inbound message) → v3
 *    `{ type: "invoke.bot", data: { bot_name, message } }` — the closest v3
 *    analog, which posts `message` to the bot so the Deluge handler receives
 *    it exactly like v2's `invoke` action. Requires a `botId` to address the
 *    bot; without it the button is dropped (no safe v3 mapping).
 *  - v2 `action: "api"` is unused by this plugin and has no v3 mapping
 *    (`system.api` calls a Cliq internal API path, not a generic HTTP hook);
 *    such buttons are dropped.
 *
 * v3 limits (per the Message Cards docs):
 *  - `title`: required, max 200 characters.
 *  - `buttons`: max 5 per card (vs v2's 10).
 *  - button `label`: max 30 characters.
 *
 * The v3 Message Card channel endpoint is
 * `POST /api/v3/channels/{CHANNEL_UNIQUE_NAME}/message` (note: `channels`,
 * NOT `channelsbyname`, and singular `message`) with scope
 * `ZohoCliq.Channels.CREATE` — a different path AND scope from the v3
 * channel *text* post (`POST /api/v3/channelsbyname/{name}/messages`,
 * scope `ZohoCliq.Webhooks.CREATE`). The v3 Message Card docs do not
 * document a `bot_unique_name` query param, so the card posts as the
 * authenticated user (the OAuth client owner), not as the bot — a behavior
 * difference from the v2 channel card path; users who need bot sender
 * identity for cards stay on `apiVersion: "v2"`.
 */
import type { CliqButton } from "./presentation.js";

/** Max title length for a v3 modern-inline card (per the Message Cards docs). */
export const V3_MAX_TITLE_LENGTH = 200;

/** Max buttons on a v3 modern-inline / prompt card (per the Message Cards docs). */
export const V3_MAX_BUTTONS_PER_CARD = 5;

/** Max visible label length for a v3 card button. */
export const V3_MAX_BUTTON_LABEL_LENGTH = 30;

/** Default card title when the source card carries no body text. */
export const V3_DEFAULT_CARD_TITLE = "Message";

/** v3 Message Card button action types (per the Message Cards docs). */
export type V3CardButtonType =
  | "open.url"
  | "invoke.function"
  | "system.api"
  | "invoke.bot"
  | "preview.url";

/** A v3 Message Card button (the shape inside `card.buttons`). */
export interface V3CardButton {
  label: string;
  action: { type: V3CardButtonType; data: Record<string, unknown> };
}

/** A v3 modern-inline Message Card body (the `card` object). */
export interface V3ModernInlineCard {
  theme: "modern-inline";
  title: string;
  thumbnail?: string;
  sections?: Array<{
    title?: string;
    fields: Array<{ title: string; value: string }>;
  }>;
  buttons?: V3CardButton[];
}

/**
 * A v3 `prompt` Message Card body (the `card` object). A focused quick-reply
 * card: just a `title` (the question / alert text) and 1–5 action buttons
 * the user taps to respond. Has NO `sections` / `thumbnail` (those are
 * `modern-inline`-only). `buttons` is REQUIRED (min 1) per the Message Cards
 * docs — a prompt with no buttons is invalid, so the renderer returns `null`
 * rather than emitting a buttonless prompt.
 */
export interface V3PromptCard {
  theme: "prompt";
  title: string;
  buttons: V3CardButton[];
}

/** A v3 Message Card `card` object (theme-discriminated). */
export type V3MessageCard = V3ModernInlineCard | V3PromptCard;

/** A v3 Message Card slide (top-level supporting content, alongside `card`). */
export interface V3MessageCardSlide {
  type: "table" | "list" | "label" | "images" | "text";
  title?: string;
  data: unknown;
}

/** A v3 Message Card message payload (posted as the request body). */
export interface V3MessageCardPayload {
  text?: string;
  card: V3MessageCard;
  slides?: V3MessageCardSlide[];
}

/** v3 Message Card theme the plugin can render. */
export type V3CardTheme = "modern-inline" | "prompt";

/**
 * The plugin's rendered card input shape (structural; matches
 * `CliqRenderedCard` from `outbound-presentation.ts` and the relevant subset
 * of `SendCardMessageOptions` from `client.ts`). Declared locally so this
 * module depends only on the leaf `presentation.ts` (no runtime / outbound
 * adapters), keeping it safe to load from `client.ts`.
 */
export interface CliqV3CardInput {
  text?: string;
  buttons?: CliqButton[];
  /** Card theme to render; defaults to `modern-inline`. `prompt` requires ≥1 button. */
  theme?: V3CardTheme;
}

/** Clamp a label to the v3 limit, suffixing with an ellipsis. */
function clampV3Label(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= V3_MAX_BUTTON_LABEL_LENGTH) return trimmed;
  return trimmed.slice(0, V3_MAX_BUTTON_LABEL_LENGTH - 1).trimEnd() + "…";
}

/**
 * Convert a v2 `CliqButton` into a v3 Message Card button. URL buttons
 * (`action: "openurl"` + `url`) become `open.url`; invoke buttons
 * (`action: "invoke"` + `data`) become `invoke.bot` carrying
 * `{ bot_name, message }` — the closest v3 analog, which posts `message`
 * back to the bot so the Deluge Message Handler receives it as an inbound
 * message (same loop as v2 `invoke`). The `api` action is unused by this
 * plugin and has no v3 mapping. Buttons missing a url/data value, or an
 * `invoke` button with no `botId` to address the bot, are dropped (return
 * `null`).
 */
export function cliqButtonToV3CardButton(
  button: CliqButton,
  botId?: string,
): V3CardButton | null {
  const label = clampV3Label(button.label);
  if (!label) return null;
  if (button.action === "openurl" && button.url) {
    return {
      label,
      action: { type: "open.url", data: { web: button.url } },
    };
  }
  if (button.action === "invoke" && button.data) {
    // Without a botId we cannot address the bot; drop the button rather than
    // synthesize a broken `invoke.bot` payload.
    if (!botId) return null;
    return {
      label,
      action: {
        type: "invoke.bot",
        data: { bot_name: botId, message: button.data },
      },
    };
  }
  // v2 `action: "api"` is unused by this plugin; no v3 mapping.
  return null;
}

/**
 * Split a body text into a v3 card title (≤200 chars, first line preferred)
 * and an optional remainder (the rest of the text). When the text is empty,
 * `title` is the provided default and `remainder` is `""`.
 */
function splitTitleAndRemainder(
  text: string,
  defaultTitle: string,
): { title: string; remainder: string } {
  const trimmed = text.trim();
  if (!trimmed) return { title: defaultTitle, remainder: "" };
  // Prefer the first line as the title; fall back to the first 200 chars.
  const nl = trimmed.indexOf("\n");
  const firstLine = nl >= 0 ? trimmed.slice(0, nl) : trimmed;
  if (firstLine.length <= V3_MAX_TITLE_LENGTH) {
    const title = firstLine.trim();
    const remainder = (nl >= 0 ? trimmed.slice(nl + 1) : "").trim();
    return { title: title || defaultTitle, remainder };
  }
  // First line alone exceeds the title cap — take the first 200 chars as the
  // title and treat the rest (current line remainder + any further lines) as
  // the slide text.
  const title = firstLine.slice(0, V3_MAX_TITLE_LENGTH).trimEnd();
  const overflow = firstLine.slice(V3_MAX_TITLE_LENGTH);
  const rest = nl >= 0 ? trimmed.slice(nl + 1) : "";
  const remainder = [overflow, rest].filter((s) => s.trim()).join("\n").trim();
  return { title: title || defaultTitle, remainder };
}

/**
 * Convert the plugin's rendered card shape into a v3 Message Card payload.
 * The `theme` (from `card.theme` or `opts.theme`, default `modern-inline`)
 * selects the v3 rendering template:
 *  - `modern-inline`: header (`title`, first line of the card text, ≤200
 *    chars) + optional `text` slide carrying the remainder + action
 *    buttons (optional; capped at 5).
 *  - `prompt`: a focused quick-reply card — `title` + 1–5 action buttons.
 *    `buttons` is REQUIRED (min 1) per the Message Cards docs; a prompt with
 *    no convertible buttons returns `null` (the caller falls back to v2 /
 *    plain text). Has no `sections` / `thumbnail` (those are
 *    `modern-inline`-only); the text remainder still becomes a `text` slide.
 *
 * The full card `text` is always kept as the top-level `text` fallback so
 * clients that don't render cards still show something. Buttons convert per
 * {@link cliqButtonToV3CardButton} (capped at 5). Returns `null` when the
 * card has neither text nor convertible buttons, OR when `theme === "prompt"`
 * and no convertible buttons survive (a buttonless prompt is invalid).
 */
export function cliqCardToV3MessageCard(
  card: CliqV3CardInput,
  opts: { botId?: string; defaultTitle?: string; theme?: V3CardTheme } = {},
): V3MessageCardPayload | null {
  const theme: V3CardTheme = card.theme ?? opts.theme ?? "modern-inline";
  const text = card.text?.trim() ?? "";
  const buttons = (card.buttons ?? [])
    .slice(0, V3_MAX_BUTTONS_PER_CARD)
    .map((b) => cliqButtonToV3CardButton(b, opts.botId))
    .filter((b): b is V3CardButton => b !== null);
  if (theme === "prompt") {
    // prompt REQUIRES ≥1 button; a buttonless prompt is invalid → null.
    if (buttons.length === 0) return null;
  } else if (!text && buttons.length === 0) {
    return null;
  }
  const defaultTitle = opts.defaultTitle ?? V3_DEFAULT_CARD_TITLE;
  const { title, remainder } = splitTitleAndRemainder(text, defaultTitle);
  const payload: V3MessageCardPayload = {
    card:
      theme === "prompt"
        ? { theme: "prompt", title, buttons }
        : { theme: "modern-inline", title },
  };
  if (text) {
    // Always include the full text as the top-level fallback (renders in
    // notification previews / clients that don't render cards).
    payload.text = text;
  }
  if (remainder) {
    payload.slides = [{ type: "text", data: remainder }];
  }
  if (theme === "modern-inline" && buttons.length > 0) {
    (payload.card as V3ModernInlineCard).buttons = buttons;
  }
  return payload;
}
