/**
 * Outbound Cliq Forms — agent-facing structured-input renderer (Phase 3).
 *
 * The inbound side (a Cliq platform Form submission forwarded by the bot's
 * Form Handler) is handled by `src/forms.ts`. This module is the **outbound**
 * counterpart: it lets an agent *solicit* structured input by rendering a
 * form definition as one or more native Cliq prompt cards (a `prompt`-theme
 * Message Card with a button per option) instead of asking for free text.
 *
 * Zoho Cliq's platform has no public REST CRUD for bot Forms (the form is
 * defined in the Cliq console and the Form Handler is a Deluge script), so
 * the portable equivalent the agent can emit at runtime is a **prompt card
 * with a button per field option**: tapping a button posts a human-readable
 * `<fieldName>: <value>` message back to the bot, which re-enters as an
 * ordinary inbound message the agent reads as the user's answer. This avoids
 * any inbound-side changes (the structured-values surfacing of a Form
 * *Handler* submission is a separate path) and works on both v2 and v3.
 *
 * The renderer is a pure function: {@link renderCliqFormCards} takes a form
 * definition ({@link CliqFormInput}) and returns an ordered list of card
 * specs ({@link CliqFormCardSpec}) the `message(action=send, form=…)` tool
 * posts via `CliqClient.sendCard`. Each `select` field with options becomes
 * its own `prompt` card (title = the field label, buttons = the options,
 * capped at the v3 prompt limit of 5); `text` / `number` fields (and select
 * fields with no options) fold into a single `modern-inline` summary card
 * that lists them as questions. A degenerate form with no viable fields
 * yields `[]` (the caller surfaces an error to the agent).
 *
 * **Parameter capture (sub-part c).** Tapping a prompt-card button posts a
 * {@link CLIQ_FORM_SENTINEL}-prefixed payload (`__cliq_form__ <field>=<value>`)
 * back to the bot as an ordinary inbound message. The inbound path
 * ({@link parseCliqFormResponse}) recognizes the sentinel, parses the
 * `<field>=<value>` pair, and surfaces it on the inbound context as a
 * `FormValues` entry (structured params for a tool call) rather than plain
 * text — so an agent-posted form's answers re-enter as structured input the
 * same way a Cliq platform Form Handler submission does (see `src/forms.ts`).
 * Free-text replies to the summary card (text / number fields, or overflow
 * select options) are NOT sentinel-prefixed and re-enter as ordinary text;
 * only prompt-card button clicks are structured.
 *
 * No new OAuth scope — prompt cards reuse the same card-path scopes
 * (`Webhooks.CREATE` for DM cards, `Channels.CREATE` / `Channels.UPDATE`
 * for channel cards) the existing `message(action=send, buttons=…)` path
 * already uses.
 */
import type { CliqButton } from "./presentation.js";
import { CLIQ_MAX_BUTTON_LABEL_LENGTH } from "./presentation.js";

/**
 * The per-card button cap for a rendered form prompt card. v3 `prompt` cards
 * allow at most 5 buttons (vs v2's 10); we cap at 5 so the card is valid on
 * both apiVersions. A field with more than 5 options renders the first 5 as
 * buttons and lists the remainder in the card body text.
 */
export const CLIQ_FORM_MAX_BUTTONS_PER_CARD = 5;

/** Max length of a rendered form card title (matches the v3 title cap). */
export const CLIQ_FORM_MAX_TITLE_LENGTH = 200;

/**
 * Prefix every prompt-card form button's `invoke.bot` message carries, so
 * the inbound path can recognize an agent-rendered form's button-click
 * answer and surface it as a structured `FormValues` entry on the inbound
 * context (parameter capture — Phase 3, sub-part c). Followed by a single
 * space and a `<fieldName>=<value>` pair. Detected on the next webhook call
 * by {@link parseCliqFormResponse}.
 */
export const CLIQ_FORM_SENTINEL = "__cliq_form__";

/**
 * A single field in an agent-rendered Cliq form. A `select` field with
 * `options` renders as a `prompt` card with a button per option; `text` /
 * `number` fields (and optionless `select` fields) render as questions in a
 * summary card body.
 */
export interface CliqFormFieldInput {
  /** Field key — used in the button callback payload (`<name>: <value>`). */
  name: string;
  /** Display label (defaults to `name` when absent). */
  label?: string;
  /**
   * Field type. `select` fields render as prompt cards with a button per
   * option; `text` / `number` render as a question in the summary card.
   * Defaults to `"text"`.
   */
  type?: "select" | "text" | "number";
  /**
   * Options for a `select` field. Each entry is `{ label, value? }` (value
   * defaults to label) or a plain string. A select field with fewer than 2
   * surviving options is treated as a text field (rendered in the summary).
   */
  options?: Array<{ label?: string; value?: string } | string>;
  /** Placeholder hint for a text / number field (shown in the summary body). */
  placeholder?: string;
}

/** Agent-facing form definition rendered as Cliq prompt card(s). */
export interface CliqFormInput {
  /** Card title (the form's question / header). Used as the first card title. */
  title?: string;
  /** The form's fields. */
  fields: CliqFormFieldInput[];
}

/**
 * A rendered card spec produced by {@link renderCliqFormCards}. The
 * `message(action=send, form=…)` tool posts each spec via
 * `CliqClient.sendCard`. `theme: "prompt"` cards carry `buttons`; a
 * `modern-inline` summary card carries only `text`.
 */
export interface CliqFormCardSpec {
  title: string;
  text?: string;
  buttons?: CliqButton[];
  theme?: "modern-inline" | "prompt";
}

/** Clamp a string to `max` chars, suffixing with an ellipsis when truncated. */
function clampText(s: string, max: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + "…";
}

/** Resolve the display label for a field (defaults to `name`). */
function fieldLabel(field: CliqFormFieldInput): string {
  const label = field.label?.trim();
  return label && label.length > 0 ? label : field.name.trim();
}

/**
 * Normalize a field's options into `{ label, value }` pairs. Accepts plain
 * strings (label = value = the string) and `{ label?, value? }` objects
 * (value defaults to label). Drops entries with no non-empty label AND no
 * non-empty value.
 */
function normalizeOptions(
  options: CliqFormFieldInput["options"],
): Array<{ label: string; value: string }> {
  if (!Array.isArray(options)) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const entry of options) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) out.push({ label: trimmed, value: trimmed });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const label = entry.label?.trim() ?? "";
    const value = entry.value?.trim() ?? "";
    if (label && value) out.push({ label, value });
    else if (label) out.push({ label, value: label });
    else if (value) out.push({ label: value, value });
  }
  return out;
}

/**
 * Build a Cliq `invoke` button for a form option. Tapping it posts a
 * {@link CLIQ_FORM_SENTINEL}-prefixed `<fieldName>=<value>` payload back to
 * the bot as an inbound message, which the inbound path
 * ({@link parseCliqFormResponse}) recognizes and surfaces as a structured
 * `FormValues` entry on the inbound context (parameter capture). The label
 * is clamped to the Cliq button-label limit.
 */
function formOptionButton(
  fieldName: string,
  option: { label: string; value: string },
): CliqButton {
  return {
    label: clampText(option.label, CLIQ_MAX_BUTTON_LABEL_LENGTH),
    type: "+",
    action: "invoke",
    data: `${CLIQ_FORM_SENTINEL} ${fieldName}=${option.value}`,
  };
}

/**
 * Render an agent-facing form definition as an ordered list of Cliq card
 * specs. Each `select` field with ≥2 surviving options becomes a `prompt`
 * card (title = the field label, or the form title for the first card;
 * buttons = the options, capped at {@link CLIQ_FORM_MAX_BUTTONS_PER_CARD}).
 * `text` / `number` fields (and optionless select fields) fold into a single
 * `modern-inline` summary card listing them as questions. Returns `[]` when
 * the form has no viable fields (the caller surfaces an error).
 *
 * The cards are ordered: the summary card (if any) comes FIRST so the user
 * sees the full question context, followed by one prompt card per select
 * field. When there is no summary card, the first prompt card carries the
 * form title; subsequent prompt cards use their field label as the title.
 */
export function renderCliqFormCards(form: CliqFormInput): CliqFormCardSpec[] {
  if (!form || !Array.isArray(form.fields)) return [];
  const formTitle = form.title?.trim() || "";
  const cards: CliqFormCardSpec[] = [];
  const summaryLines: string[] = [];
  const selectFields: CliqFormFieldInput[] = [];

  for (const field of form.fields) {
    if (!field || typeof field !== "object") continue;
    const name = field.name?.trim();
    if (!name) continue;
    const type = field.type ?? "text";
    if (type === "select") {
      const options = normalizeOptions(field.options);
      if (options.length >= 2) {
        selectFields.push(field);
        continue;
      }
    }
    // text / number / optionless select → summary question
    const label = fieldLabel(field);
    const placeholder = field.placeholder?.trim();
    const hint =
      type === "number"
        ? " (number)"
        : placeholder
          ? ` (${placeholder})`
          : "";
    summaryLines.push(`• ${label}${hint} — reply with \`${name}: <value>\``);
  }

  // Summary card (text/number fields) — posted first so the user sees the
  // full context before the prompt cards.
  if (summaryLines.length > 0) {
    const title = clampText(
      formTitle || "Please provide the following:",
      CLIQ_FORM_MAX_TITLE_LENGTH,
    );
    cards.push({
      title,
      text: summaryLines.join("\n"),
      theme: "modern-inline",
    });
  }

  // One prompt card per select field.
  let firstPrompt = true;
  for (const field of selectFields) {
    const name = field.name.trim();
    const options = normalizeOptions(field.options);
    const buttons = options
      .slice(0, CLIQ_FORM_MAX_BUTTONS_PER_CARD)
      .map((o) => formOptionButton(name, o));
    if (buttons.length === 0) continue;
    // Title: form title on the first prompt card (when there's no summary
    // card to carry it); otherwise the field label.
    const titleSource =
      !firstPrompt || cards.length > 0 || !formTitle
        ? fieldLabel(field)
        : formTitle;
    const title = clampText(titleSource, CLIQ_FORM_MAX_TITLE_LENGTH);
    const spec: CliqFormCardSpec = {
      title,
      buttons,
      theme: "prompt",
    };
    // If there are more options than buttons, list the remainder in the body.
    if (options.length > buttons.length) {
      const remainder = options
        .slice(CLIQ_FORM_MAX_BUTTONS_PER_CARD)
        .map((o) => o.label);
      spec.text = `More options: ${remainder.join(", ")} (reply with \`${name}: <value>\`)`;
    }
    cards.push(spec);
    firstPrompt = false;
  }

  return cards;
}

/**
 * Read a `form` param (the agent-friendly shape) defensively. Each entry
 * must be an object with a string `name`; `type` defaults to `"text"`.
 * `options` entries may be strings or `{ label, value }` objects. Non-array
 * / non-object entries are dropped; an empty / wholly-invalid form yields
 * `null` (the caller surfaces an error). This is the parsing counterpart to
 * {@link renderCliqFormCards} — it accepts the loose shape an agent passes
 * via the `message(action=send, form=…)` tool and yields the typed
 * {@link CliqFormInput} the renderer consumes.
 */
export function readFormParam(raw: unknown): CliqFormInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const title = typeof rec.title === "string" ? rec.title.trim() : undefined;
  const rawFields = rec.fields;
  if (!Array.isArray(rawFields)) return null;
  const fields: CliqFormFieldInput[] = [];
  for (const entry of rawFields) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const f = entry as Record<string, unknown>;
    const name = typeof f.name === "string" ? f.name.trim() : "";
    if (!name) continue;
    const field: CliqFormFieldInput = { name };
    if (typeof f.label === "string" && f.label.trim()) field.label = f.label.trim();
    if (f.type === "select" || f.type === "text" || f.type === "number") {
      field.type = f.type;
    }
    if (Array.isArray(f.options)) field.options = f.options as CliqFormFieldInput["options"];
    if (typeof f.placeholder === "string" && f.placeholder.trim()) {
      field.placeholder = f.placeholder.trim();
    }
    fields.push(field);
  }
  if (fields.length === 0) return null;
  return { ...(title ? { title } : {}), fields };
}

/**
 * Result of inspecting an inbound message text for an agent-rendered form
 * button-click response (the {@link CLIQ_FORM_SENTINEL} payload a prompt-card
 * button posts). When `matched` is true, `formValues` holds the parsed
 * `<field>=<value>` pair (a single entry — one button click answers one
 * field), `body` is the agent-readable plain-text rendering
 * (`<field>: <value>`), and `text` is the message with the sentinel stripped
 * (equal to `body` when matched). When no sentinel is present, `matched` is
 * `false`, `formValues` is `{}`, and `text` is the input verbatim (trimmed).
 */
export interface CliqFormResponseParse {
  matched: boolean;
  formValues: Record<string, string>;
  body: string;
  text: string;
}

/**
 * Inspect a raw inbound message text for an agent-rendered form button-click
 * response. A prompt-card button posts
 * `__cliq_form__ <fieldName>=<value>` as the message text; this parses the
 * `<fieldName>=<value>` pair (split on the first `=` so a value may contain
 * `=`) and returns it as a structured `formValues` entry. The recovered
 * `<field>: <value>` rendering becomes the agent-readable body. Returns
 * `{ matched: false, … }` when the text carries no form sentinel (an
 * ordinary message). A sentinel with no `=` (malformed) is still recognized
 * as a form response but yields an empty `formValues` and a body equal to
 * the text after the sentinel.
 */
export function parseCliqFormResponse(raw: string): CliqFormResponseParse {
  const text = raw ?? "";
  const prefix = CLIQ_FORM_SENTINEL + " ";
  if (!text.startsWith(prefix)) {
    return { matched: false, formValues: {}, body: "", text: text.trim() };
  }
  const rest = text.slice(prefix.length).trim();
  const eq = rest.indexOf("=");
  if (eq < 0) {
    return { matched: true, formValues: {}, body: rest, text: rest };
  }
  const key = rest.slice(0, eq).trim();
  const value = rest.slice(eq + 1).trim();
  if (!key) {
    return { matched: true, formValues: {}, body: rest, text: rest };
  }
  const body = `${key}: ${value}`;
  return {
    matched: true,
    formValues: { [key]: value },
    body,
    text: body,
  };
}
