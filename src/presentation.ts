/**
 * Portable message-presentation → Zoho Cliq card/button rendering.
 *
 * The OpenClaw Plugin SDK defines a portable `MessagePresentation` shape
 * (text / context / divider / buttons / select blocks) that channels render
 * into their native interactive surfaces. The SDK does not re-export the
 * `MessagePresentation` types from a public subpath, so this module declares
 * structural local types matching the portable shape and converts them into
 * the Cliq bot-message payload (`{ text?, buttons? }`).
 *
 * Cliq button payload (per the Zoho Cliq Bot Message API):
 *   { label, type: "+"|"-"|"post", action: "openurl"|"invoke"|"api",
 *     url?, data? }
 * - `action: "openurl"` opens `url` in the user's browser.
 * - `action: "invoke"` posts `data` back to the bot handler (the same
 *   Deluge webhook that receives messages); the plugin receives it as an
 *   inbound message whose text is the `data` string. This is the closest
 *   Cliq analog to a Telegram callback button.
 * - `action: "api"` performs an HTTP call to `url` (not used here).
 *
 * Cliq limits: a single bot message accepts up to 10 buttons; button labels
 * are capped at 30 characters. Style hints (primary/danger/…) have no Cliq
 * equivalent and are dropped. Select/menu blocks degrade to a row of buttons
 * (one per option). Divider/context blocks fold into the body text.
 */


/** Max buttons on a single Cliq bot message (per the Cliq Bot Message API). */
export const CLIQ_MAX_BUTTONS_PER_MESSAGE = 10;

/** Max visible label length for a Cliq button. */
export const CLIQ_MAX_BUTTON_LABEL_LENGTH = 30;

/**
 * Presentation capabilities advertised to the SDK's outbound adapter.
 * Structural local type (the SDK does not re-export
 * `ChannelPresentationCapabilities` from a public subpath) matching the
 * `ChannelPresentationCapabilities` shape from `outbound.types`.
 */
export interface CliqPresentationCapabilities {
  supported?: boolean;
  buttons?: boolean;
  selects?: boolean;
  context?: boolean;
  divider?: boolean;
  limits?: {
    actions?: {
      maxActions?: number;
      maxActionsPerRow?: number;
      maxRows?: number;
      maxLabelLength?: number;
      maxValueBytes?: number;
      supportsStyles?: boolean;
      supportsDisabled?: boolean;
      supportsLayoutHints?: boolean;
    };
    selects?: {
      maxOptions?: number;
      maxLabelLength?: number;
      maxValueBytes?: number;
    };
    text?: {
      maxLength?: number;
      encoding?: "characters" | "utf8-bytes" | "utf16-units";
      markdownDialect?: "plain" | "markdown" | "html" | "slack-mrkdwn" | "discord-markdown";
      supportsEdit?: boolean;
    };
  };
}

/** A Cliq-native button object as posted in the bot-message payload. */
export interface CliqButton {
  label: string;
  type: "+" | "-" | "post";
  action: "openurl" | "invoke" | "api";
  url?: string;
  data?: string;
}

/** Portable action behind a button (subset of the SDK's MessagePresentationAction). */
export interface PortableButtonAction {
  type: "command" | "callback";
  command?: string;
  value?: string;
}

/** Portable button (subset of the SDK's MessagePresentationButton). */
export interface PortableButton {
  label: string;
  action?: PortableButtonAction;
  value?: string;
  url?: string;
  style?: "primary" | "secondary" | "success" | "danger";
  disabled?: boolean;
}

/** Portable select option (subset of the SDK's MessagePresentationOption). */
export interface PortableOption {
  label: string;
  action?: PortableButtonAction;
  value?: string;
}

/** Portable presentation block (subset of the SDK's MessagePresentationBlock). */
export type PortableBlock =
  | { type: "text"; text: string }
  | { type: "context"; text: string }
  | { type: "divider" }
  | { type: "buttons"; buttons: PortableButton[] }
  | { type: "select"; placeholder?: string; options: PortableOption[] };

/** Portable presentation (subset of the SDK's MessagePresentation). */
export interface PortablePresentation {
  title?: string;
  tone?: "info" | "success" | "warning" | "danger" | "neutral";
  blocks: PortableBlock[];
}

/**
 * Cliq presentation capabilities advertised to the SDK's outbound adapter.
 * Cliq renders buttons natively (the bot-message `buttons` field); selects
 * degrade to button rows; context/divider blocks fold into text. Styles are
 * not preserved (Cliq has no button style concept).
 */
export const CLIQ_PRESENTATION_CAPABILITIES: CliqPresentationCapabilities = {
  supported: true,
  buttons: true,
  selects: false,
  context: false,
  divider: false,
  limits: {
    actions: {
      maxActions: CLIQ_MAX_BUTTONS_PER_MESSAGE,
      maxActionsPerRow: CLIQ_MAX_BUTTONS_PER_MESSAGE,
      maxRows: 1,
      maxLabelLength: CLIQ_MAX_BUTTON_LABEL_LENGTH,
      maxValueBytes: 1024,
      supportsStyles: false,
      supportsDisabled: false,
      supportsLayoutHints: false,
    },
  },
};

/** Clamp a button label to the Cliq limit, suffixing with an ellipsis. */
function clampLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= CLIQ_MAX_BUTTON_LABEL_LENGTH) return trimmed;
  return trimmed.slice(0, CLIQ_MAX_BUTTON_LABEL_LENGTH - 1).trimEnd() + "…";
}

/** Resolve the callback value (command text or opaque value) for an invoke button. */
function resolveCallbackValue(
  action?: PortableButtonAction,
  value?: string,
): string | undefined {
  if (action?.type === "command" && action.command?.trim()) {
    return action.command.trim();
  }
  if (action?.type === "callback" && action.value) return action.value;
  return value;
}

/**
 * Convert a single portable button into a Cliq-native button object. URL
 * buttons become `action: "openurl"`; callback/command/value buttons become
 * `action: "invoke"` carrying the resolved value as `data` (the Deluge
 * handler will receive it as an inbound message). Buttons with neither a URL
 * nor a callback value are dropped — Cliq has no "label-only" button.
 */
export function cliqButtonFromPortable(button: PortableButton): CliqButton | undefined {
  if (button.disabled) return undefined;
  const label = clampLabel(button.label);
  if (!label) return undefined;
  if (button.url) {
    return { label, type: "+", action: "openurl", url: button.url };
  }
  const data = resolveCallbackValue(button.action, button.value);
  if (!data) return undefined;
  return { label, type: "+", action: "invoke", data };
}

/**
 * Convert a portable select option into a Cliq button. Each option becomes an
 * invoke button whose `data` is the option's value (or label fallback).
 */
export function cliqButtonFromOption(option: PortableOption): CliqButton | undefined {
  const label = clampLabel(option.label);
  if (!label) return undefined;
  const data = resolveCallbackValue(option.action, option.value) ?? label;
  return { label, type: "+", action: "invoke", data };
}

/**
 * Convert a full portable presentation into the Cliq bot-message payload.
 *
 * - `title` (when present) prefixes the body text on its own line.
 * - text/context blocks concatenate (in order) into the `text` field;
 *   divider blocks insert a Cliq horizontal rule (`---`) between sections.
 * - buttons blocks flatten into the `buttons` array (capped at
 *   `CLIQ_MAX_BUTTONS_PER_MESSAGE`); select blocks flatten their options
 *   into buttons the same way.
 *
 * Returns `{ text?, buttons? }`. A presentation that yields neither text nor
 * buttons returns an empty object (the caller treats it as a no-op and falls
 * back to plain text).
 */
export function presentationToCliqCard(
  presentation: PortablePresentation,
): { title?: string; text?: string; buttons?: CliqButton[] } {
  const textParts: string[] = [];
  const buttons: CliqButton[] = [];
  if (presentation.title?.trim()) {
    textParts.push(presentation.title.trim());
  }
  for (const block of presentation.blocks ?? []) {
    switch (block.type) {
      case "text":
        if (block.text?.trim()) textParts.push(block.text);
        break;
      case "context":
        if (block.text?.trim()) textParts.push(block.text);
        break;
      case "divider":
        textParts.push("---");
        break;
      case "buttons":
        for (const b of block.buttons ?? []) {
          if (buttons.length >= CLIQ_MAX_BUTTONS_PER_MESSAGE) break;
          const converted = cliqButtonFromPortable(b);
          if (converted) buttons.push(converted);
        }
        break;
      case "select":
        for (const o of block.options ?? []) {
          if (buttons.length >= CLIQ_MAX_BUTTONS_PER_MESSAGE) break;
          const converted = cliqButtonFromOption(o);
          if (converted) buttons.push(converted);
        }
        break;
    }
  }
  const result: { title?: string; text?: string; buttons?: CliqButton[] } = {};
  if (textParts.length > 0) result.text = textParts.join("\n\n");
  if (buttons.length > 0) result.buttons = buttons;
  return result;
}

/**
 * Convert a simple `buttons` param (the agent-friendly shape: an array of
 * `{ label, url?, value? }`) into Cliq-native buttons. This is the shape the
 * `message(action=send, buttons=[...])` tool param accepts — simpler than a
 * full portable presentation, for the common "attach a few link/callback
 * buttons to a message" case.
 */
export function simpleButtonsToCliqButtons(
  buttons: unknown[],
): CliqButton[] {
  const out: CliqButton[] = [];
  for (const entry of buttons) {
    if (out.length >= CLIQ_MAX_BUTTONS_PER_MESSAGE) break;
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const label =
      typeof rec.label === "string" ? rec.label
        : typeof rec.text === "string" ? rec.text
        : "";
    const url = typeof rec.url === "string" ? rec.url : undefined;
    const value =
      typeof rec.value === "string" ? rec.value
        : typeof rec.data === "string" ? rec.data
        : typeof rec.command === "string" ? rec.command
        : undefined;
    const converted = cliqButtonFromPortable({ label, url, value });
    if (converted) out.push(converted);
  }
  return out;
}
