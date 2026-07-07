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
 *  - `poll` — a voting card: `title` + 2–10 `options` (each `{ text }`, ≤100
 *    chars). Cliq tracks live vote counts + percentages natively — a poll
 *    does NOT post anything back to the bot (votes are counted in-place by
 *    Cliq, not surfaced as an inbound message). `buttons` is ignored for a
 *    poll (voting options are not action buttons); the options come from
 *    `pollOptions` on the input. A poll with fewer than 2 surviving options
 *    is invalid → the renderer returns `null`.
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

/** Max number of supporting-content `slides` per message (defensive cap). */
export const V3_MAX_SLIDES = 20;

/** Max headers in a single v3 `table` slide (defensive cap). */
export const V3_MAX_TABLE_HEADERS = 20;

/** Max rows in a single v3 `table` slide (defensive cap). */
export const V3_MAX_TABLE_ROWS = 50;

/** Max cells in a single v3 `list` / `label` slide (defensive cap). */
export const V3_MAX_LIST_ITEMS = 50;

/** Max images in a single v3 `images` slide (defensive cap). */
export const V3_MAX_IMAGE_URLS = 10;

/** Max text length for a single v3 slide title (defensive cap, chars). */
export const V3_MAX_SLIDE_TITLE_LENGTH = 100;

/** Max text length for a single v3 `text` slide body (defensive cap, chars). */
export const V3_MAX_SLIDE_TEXT_LENGTH = 4000;

/** Max text length for a single v3 table cell / list item / label value (chars). */
export const V3_MAX_SLIDE_CELL_LENGTH = 200;

/** Min poll options on a v3 poll card (per the Message Cards docs). */
export const V3_MIN_POLL_OPTIONS = 2;

/** Max poll options on a v3 poll card (per the Message Cards docs). */
export const V3_MAX_POLL_OPTIONS = 10;

/** Max labeled-field `sections` in a single v3 modern-inline card body (defensive cap). */
export const V3_MAX_SECTIONS = 10;

/** Max `fields` in a single v3 modern-inline card section (defensive cap). */
export const V3_MAX_SECTION_FIELDS = 50;

/** Max text length for a single v3 modern-inline card section title (defensive cap, chars). */
export const V3_MAX_SECTION_TITLE_LENGTH = 100;

/** Max text length for a single v3 modern-inline card section field title/value (chars). */
export const V3_MAX_SECTION_FIELD_LENGTH = 200;

/** Max length of a v3 modern-inline card `thumbnail` URL (defensive cap, chars). */
export const V3_MAX_THUMBNAIL_URL_LENGTH = 2048;

/** Max text length for a single v3 poll option (per the Message Cards docs). */
export const V3_MAX_POLL_OPTION_LENGTH = 100;

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
export type V3MessageCard = V3ModernInlineCard | V3PromptCard | V3PollCard;

/** A v3 Message Card slide (top-level supporting content, alongside `card`). */
export interface V3MessageCardSlide {
  type: "table" | "list" | "label" | "images" | "text";
  title?: string;
  data: unknown;
}

/**
 * Input shape for a v3 Message Card supporting-content slide. A discriminated
 * union over `type`; the `data` payload structure is per-type per the v3
 * Message Cards docs (`slides` table):
 *  - `table`: `{ headers: string[], rows: Record<string,string>[] }` — a data
 *    table whose row keys map to a header.
 *  - `list`: `string[]` — a bulleted list of items.
 *  - `label`: `Array<{ label, value }>` — key/value pairs.
 *  - `images`: `string[]` — publicly accessible HTTPS image URLs.
 *  - `text`: `string` — a plain / formatted text block.
 *
 * The input uses field names that read naturally for an agent / tool caller
 * (`headers`/`rows`, `items`, `pairs`, `urls`, `text`); the normalizer maps
 * them onto the v3 `data` payload and clamps / drops invalid entries. An
 * empty / wholly-invalid slide yields `null` (dropped) rather than a degenerate
 * slide the API would reject.
 */
export type V3CardSlideInput =
  | { type: "table"; title?: string; headers: string[]; rows: Record<string, string>[] }
  | { type: "list"; title?: string; items: string[] }
  | { type: "label"; title?: string; pairs: Array<{ label: string; value: string }> }
  | { type: "images"; title?: string; urls: string[] }
  | { type: "text"; title?: string; text: string };

/**
 * Input shape for a v3 modern-inline card `sections` entry (an in-card
 * labeled field group, NOT a top-level slide). Per the Message Cards docs
 * (`modern-inline` card body):
 *  - `title`: optional section heading displayed above the fields.
 *  - `fields`: a list of key/value pairs (`{ title, value }`).
 * The normalizer maps each entry onto the v3 `sections` payload, clamps
 * titles + field values, drops fields with an empty title OR value, and
 * drops an empty / wholly-invalid section entirely.
 */
export interface V3CardSectionInput {
  title?: string;
  fields: Array<{ title: string; value: string }>;
}

/** A v3 Message Card message payload (posted as the request body). */
export interface V3MessageCardPayload {
  text?: string;
  card: V3MessageCard;
  slides?: V3MessageCardSlide[];
}

/** v3 Message Card theme the plugin can render. */
export type V3CardTheme = "modern-inline" | "prompt" | "poll";

/**
 * A v3 `poll` Message Card body (the `card` object). A voting card: a
 * `title` (the poll question, ≤200 chars) + 2–10 `options` (each
 * `{ text }`, ≤100 chars). Cliq tracks live vote counts + percentages
 * natively — a vote does NOT post anything back to the bot (votes are
 * counted in-place by Cliq), so a poll has no `buttons` field. `options`
 * is REQUIRED (min 2) per the Message Cards docs — a poll with fewer than
 * 2 surviving options is invalid, so the renderer returns `null`.
 */
export interface V3PollCard {
  theme: "poll";
  title: string;
  options: Array<{ text: string }>;
}

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
  /**
   * Card theme to render; defaults to `modern-inline`. `prompt` requires
   * ≥1 button; `poll` requires ≥2 `pollOptions` (and ignores `buttons`).
   */
  theme?: V3CardTheme;
  /**
   * Voting options for a `poll` theme card (each a plain-text string, ≤100
   * chars). Ignored for `modern-inline` / `prompt`. Cliq counts votes
   * natively — a poll has no action buttons.
   */
  pollOptions?: string[];
  /**
   * Supporting-content slides attached to the top-level `slides` array
   * (compatible with ALL card themes — `slides` sits alongside `card`, not
   * inside it). Each entry is a discriminated-union `V3CardSlideInput`; the
   * renderer validates + clamps each slide (drops empties / non-HTTPS image
   * URLs / over-cap entries) and appends the survivors after any text-
   * remainder slide derived from `text`. Invalid slides are dropped silently
   * (never throw) so a malformed slide never fails the whole send.
   */
  slides?: V3CardSlideInput[];
  /**
   * Header thumbnail URL for a `modern-inline` card (a publicly accessible
   * HTTPS URL shown in the card header next to the `title`). `modern-inline`
   * only — ignored for `prompt` / `poll`. Non-HTTPS / over-length URLs are
   * dropped silently (never fail the send). No `thumbnail` is emitted when
   * the URL is invalid or absent.
   */
  thumbnail?: string;
  /**
   * In-card labeled field `sections` for a `modern-inline` card body (NOT a
   * top-level slide — `sections` nests inside `card`, alongside `title` /
   * `thumbnail` / `buttons`). `modern-inline` only — ignored for `prompt` /
   * `poll`. Each entry is a `V3CardSectionInput` (`{ title?, fields: [{ title,
   * value }] }`); the renderer clamps titles + field values, drops fields
   * with an empty title OR value, and drops empty sections entirely. Invalid
   * sections are dropped silently (never fail the send).
   */
  sections?: V3CardSectionInput[];
}

/** Clamp a label to the v3 limit, suffixing with an ellipsis. */
function clampV3Label(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= V3_MAX_BUTTON_LABEL_LENGTH) return trimmed;
  return trimmed.slice(0, V3_MAX_BUTTON_LABEL_LENGTH - 1).trimEnd() + "…";
}

/**
 * Clamp a poll option text to the v3 limit (100 chars), suffixing with an
 * ellipsis. Whitespace-only options are dropped (returned as `""`).
 */
function clampV3PollOption(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= V3_MAX_POLL_OPTION_LENGTH) return trimmed;
  return trimmed.slice(0, V3_MAX_POLL_OPTION_LENGTH - 1).trimEnd() + "…";
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

/** Clamp a string to `limit` chars, suffixing with an ellipsis on overflow. */
function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).trimEnd() + "…";
}

/** Clamp a slide title to the v3 cap, dropping a whitespace-only title. */
function clampSlideTitle(title: string | undefined): string | undefined {
  const t = title?.trim();
  if (!t) return undefined;
  return clampText(t, V3_MAX_SLIDE_TITLE_LENGTH);
}

/**
 * Normalize a single v3 Message Card supporting-content slide input into the
 * v3 `slides` payload shape, validating + clamping each entry. Returns `null`
 * when the slide is empty / wholly invalid (so a degenerate slide is dropped
 * rather than emitted — the API would reject an empty `headers` array, a
 * zero-item list, etc.). Per the v3 Message Cards docs (`slides` table):
 *  - `table`: `data = { headers: string[], rows: Record<string,string>[] }`.
 *  - `list`: `data = string[]`.
 *  - `label`: `data = Array<{ label, value }>`.
 *  - `images`: `data = string[]` (HTTPS URLs only — non-HTTPS dropped).
 *  - `text`: `data = string`.
 */
export function normalizeV3Slide(slide: V3CardSlideInput): V3MessageCardSlide | null {
  const title = clampSlideTitle(slide.title);
  switch (slide.type) {
    case "table": {
      const headers = (slide.headers ?? [])
        .map((h) => clampText(h.trim(), V3_MAX_SLIDE_CELL_LENGTH))
        .filter((h) => h.length > 0)
        .slice(0, V3_MAX_TABLE_HEADERS);
      if (headers.length === 0) return null;
      const rows = (slide.rows ?? [])
        .slice(0, V3_MAX_TABLE_ROWS)
        .map((row) => {
          const out: Record<string, string> = {};
          for (const h of headers) {
            const v = row?.[h];
            if (v !== undefined && v !== null) {
              out[h] = clampText(String(v), V3_MAX_SLIDE_CELL_LENGTH);
            }
          }
          return out;
        });
      return { type: "table", ...(title ? { title } : {}), data: { headers, rows } };
    }
    case "list": {
      const items = (slide.items ?? [])
        .map((i) => clampText(String(i ?? "").trim(), V3_MAX_SLIDE_CELL_LENGTH))
        .filter((i) => i.length > 0)
        .slice(0, V3_MAX_LIST_ITEMS);
      if (items.length === 0) return null;
      return { type: "list", ...(title ? { title } : {}), data: items };
    }
    case "label": {
      const pairs = (slide.pairs ?? [])
        .slice(0, V3_MAX_LIST_ITEMS)
        .map((p) => ({
          label: clampText(String(p?.label ?? "").trim(), V3_MAX_SLIDE_CELL_LENGTH),
          value: clampText(String(p?.value ?? "").trim(), V3_MAX_SLIDE_CELL_LENGTH),
        }))
        .filter((p) => p.label.length > 0 && p.value.length > 0);
      if (pairs.length === 0) return null;
      return { type: "label", ...(title ? { title } : {}), data: pairs };
    }
    case "images": {
      const urls = (slide.urls ?? [])
        .map((u) => String(u ?? "").trim())
        .filter((u) => /^https:\/\//i.test(u))
        .slice(0, V3_MAX_IMAGE_URLS);
      if (urls.length === 0) return null;
      return { type: "images", ...(title ? { title } : {}), data: urls };
    }
    case "text": {
      const text = clampText(String(slide.text ?? "").trim(), V3_MAX_SLIDE_TEXT_LENGTH);
      if (!text) return null;
      return { type: "text", ...(title ? { title } : {}), data: text };
    }
    default:
      return null;
  }
}

/**
 * Normalize an array of v3 Message Card slide inputs into the v3 `slides`
 * payload (dropping invalid entries; capped at `V3_MAX_SLIDES`). Returns
 * `undefined` when no slides survive (so the payload omits `slides` entirely).
 */
export function normalizeV3Slides(
  slides: V3CardSlideInput[] | undefined,
): V3MessageCardSlide[] | undefined {
  if (!slides || slides.length === 0) return undefined;
  const out: V3MessageCardSlide[] = [];
  for (const s of slides) {
    if (out.length >= V3_MAX_SLIDES) break;
    const n = normalizeV3Slide(s);
    if (n) out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

/** Clamp a string to `limit` chars, suffixing with an ellipsis on overflow. */
function clampSectionTitle(title: string): string | undefined {
  const t = title?.trim();
  if (!t) return undefined;
  return clampText(t, V3_MAX_SECTION_TITLE_LENGTH);
}

/**
 * Normalize a single v3 modern-inline card `sections` entry (an in-card
 * labeled field group) into the v3 payload shape, validating + clamping each
 * field. Returns `null` when the section has no surviving fields (so a
 * degenerate section is dropped rather than emitted — the API would reject an
 * empty `fields` array). Per the Message Cards docs (`modern-inline` card
 * body): `sections[].title` is optional; `sections[].fields` is an array of
 * `{ title, value }` pairs.
 */
export function normalizeV3Section(
  section: V3CardSectionInput,
): { title?: string; fields: Array<{ title: string; value: string }> } | null {
  const title = clampSectionTitle(section.title ?? "");
  const fields = (section.fields ?? [])
    .slice(0, V3_MAX_SECTION_FIELDS)
    .map((f) => ({
      title: clampText(String(f?.title ?? "").trim(), V3_MAX_SECTION_FIELD_LENGTH),
      value: clampText(String(f?.value ?? "").trim(), V3_MAX_SECTION_FIELD_LENGTH),
    }))
    .filter((f) => f.title.length > 0 && f.value.length > 0);
  if (fields.length === 0) return null;
  return { ...(title ? { title } : {}), fields };
}

/**
 * Normalize an array of v3 modern-inline card `sections` inputs into the v3
 * `sections` payload (dropping invalid entries; capped at `V3_MAX_SECTIONS`).
 * Returns `undefined` when no sections survive (so the card omits `sections`
 * entirely).
 */
export function normalizeV3Sections(
  sections: V3CardSectionInput[] | undefined,
): Array<{ title?: string; fields: Array<{ title: string; value: string }> }> | undefined {
  if (!sections || sections.length === 0) return undefined;
  const out: Array<{ title?: string; fields: Array<{ title: string; value: string }> }> = [];
  for (const s of sections) {
    if (out.length >= V3_MAX_SECTIONS) break;
    const n = normalizeV3Section(s);
    if (n) out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Normalize a v3 modern-inline card `thumbnail` URL. Per the Message Cards
 * docs the thumbnail must be a publicly accessible HTTPS URL; non-HTTPS /
 * empty / over-length values are dropped (return `undefined`), never thrown.
 */
export function normalizeV3Thumbnail(url: string | undefined): string | undefined {
  const u = String(url ?? "").trim();
  if (!u) return undefined;
  if (!/^https:\/\//i.test(u)) return undefined;
  if (u.length > V3_MAX_THUMBNAIL_URL_LENGTH) return undefined;
  return u;
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
 *  - `poll`: a voting card — `title` + 2–10 `options` (each `{ text }`,
 *    ≤100 chars). `buttons` is IGNORED for a poll (voting options are not
 *    action buttons); the options come from `card.pollOptions`. Cliq counts
 *    votes natively (no callback to the bot). A poll with fewer than 2
 *    surviving options is invalid → returns `null`. The text remainder (the
 *    card body past the first line) still becomes a `text` slide, exactly as
 *    for the other themes.
 *
 * The full card `text` is always kept as the top-level `text` fallback so
 * clients that don't render cards still show something. Buttons convert per
 * {@link cliqButtonToV3CardButton} (capped at 5). Returns `null` when the
 * card has neither text nor convertible buttons (modern-inline), OR when
 * `theme === "prompt"` and no convertible buttons survive (a buttonless
 * prompt is invalid), OR when `theme === "poll"` and fewer than 2 poll
 * options survive (a <2-option poll is invalid).
 */
export function cliqCardToV3MessageCard(
  card: CliqV3CardInput,
  opts: { botId?: string; defaultTitle?: string; theme?: V3CardTheme } = {},
): V3MessageCardPayload | null {
  const theme: V3CardTheme = card.theme ?? opts.theme ?? "modern-inline";
  const text = card.text?.trim() ?? "";
  if (theme === "poll") {
    // poll REQUIRES ≥2 surviving options; voting options are NOT buttons.
    const options = (card.pollOptions ?? [])
      .map((o) => clampV3PollOption(o))
      .filter((t) => t.length > 0)
      .slice(0, V3_MAX_POLL_OPTIONS)
      .map((t) => ({ text: t }));
    if (options.length < V3_MIN_POLL_OPTIONS) return null;
    const defaultTitle = opts.defaultTitle ?? V3_DEFAULT_CARD_TITLE;
    const { title, remainder } = splitTitleAndRemainder(text, defaultTitle);
    const payload: V3MessageCardPayload = {
      card: { theme: "poll", title, options },
    };
    if (text) payload.text = text;
    if (remainder) payload.slides = [{ type: "text", data: remainder }];
    const extraSlides = normalizeV3Slides(card.slides);
    if (extraSlides) {
      payload.slides = [...(payload.slides ?? []), ...extraSlides];
    }
    return payload;
  }
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
  const extraSlides = normalizeV3Slides(card.slides);
  if (extraSlides) {
    payload.slides = [...(payload.slides ?? []), ...extraSlides];
  }
  if (theme === "modern-inline") {
    const cardBody = payload.card as V3ModernInlineCard;
    if (buttons.length > 0) cardBody.buttons = buttons;
    // `thumbnail` + `sections` are modern-inline-only in-card fields (NOT
    // top-level slides); ignored for prompt / poll. Invalid entries are
    // dropped silently — a bad thumbnail / section never fails the send.
    const thumbnail = normalizeV3Thumbnail(card.thumbnail);
    if (thumbnail) cardBody.thumbnail = thumbnail;
    const sections = normalizeV3Sections(card.sections);
    if (sections) cardBody.sections = sections;
  }
  return payload;
}
