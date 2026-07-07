/**
 * Cliq Forms — inbound structured-input support (Phase 3).
 *
 * Zoho Cliq's platform **Forms** let a bot owner define a structured form
 * (text / number / dropdown / date / … fields) that a user fills out from the
 * bot's command surface. On submission the bot's **Form Handler** Deluge
 * script fires and can forward the submitted values to our webhook via the
 * same `invokeUrl` POST the Message / Mention / Welcome handlers use.
 *
 * The forwarded payload is recognized when:
 *  - `handler` is `"form"` (case-insensitive), OR
 *  - a `form` / `values` / `form_data` / `formvalues` field carrying a
 *    non-empty object of submitted values is present.
 *
 * This module parses such a payload into a normalized {@link CliqFormSubmission}
 * (form name + a string-keyed map of raw values), and renders a structured
 * plain-text body the agent receives in place of free text — so a form
 * submission is dispatched as an ordinary agent turn whose body reads, e.g.:
 *
 * ```
 * Form: approval_request
 * approver: alice@corp.com
 * priority: high
 * reason: prod deploy gate
 * ```
 *
 * The raw structured values are ALSO surfaced on the inbound context as
 * `FormValues` / `FormName` (see `dispatchCliqInbound`) so an agent tool or
 * downstream flow can read them as structured data, not just as text.
 *
 * Routing: a form submission is a directed action at the bot (the user
 * explicitly opened a form on the bot), so the inbound path marks it as an
 * implicit mention (`isMention: true`) — group form submissions are admitted
 * without a separate @mention. DM admission (`dmPolicy` / `allowFrom`) and
 * self-message / dedupe guards apply unchanged.
 *
 * No new OAuth scope — the Form Handler is a bot handler that posts to the
 * webhook over the existing `x-cliq-webhook-secret` authenticated transport,
 * the same as Message / Mention / Welcome. No native Cliq Form is registered
 * programmatically by this plugin (the platform has no public REST CRUD for
 * bot Forms); the operator defines the form in the Cliq bot console and
 * points the Form Handler's `invokeUrl` at `/cliq/webhook`. See README.
 */

/**
 * Normalized Cliq Form submission. `values` is the raw submitted field map
 * (string keys → primitive | array | `{label,value}` object values); `body`
 * is the agent-readable plain-text rendering of those values.
 */
export interface CliqFormSubmission {
  /** Form display name (best-effort, from `form.name` / `form_name`). */
  formName?: string;
  /** Raw submitted field values (string-keyed). */
  values: Record<string, unknown>;
  /** Agent-readable plain-text rendering of the submission. */
  body: string;
}

/**
 * The raw payload shape a Deluge Form Handler forwards. The submitted values
 * may live under any of `values` / `form.values` / `form_data` /
 * `formvalues`; the form name under `form.name` / `form_name` /
 * `form.link_name`. All variants are tolerated.
 */
export interface CliqFormWebhookPayload {
  handler?: string;
  form?: { name?: string; link_name?: string; values?: Record<string, unknown> };
  values?: Record<string, unknown>;
  form_data?: Record<string, unknown>;
  formvalues?: Record<string, unknown>;
  form_name?: string;
  /** Some Deluge handlers wrap the event in `params`. */
  params?: {
    form?: CliqFormWebhookPayload["form"];
    values?: Record<string, unknown>;
    form_data?: Record<string, unknown>;
    formvalues?: Record<string, unknown>;
    form_name?: string;
  };
}

/**
 * Detect whether a raw webhook payload is a Cliq Form submission we can
 * parse. Returns true only when a non-empty values object resolves under any
 * tolerated placement (`values` / `form.values` / `form_data` /
 * `formvalues`, including the `params` wrapper). A `handler: "form"` marker
 * is the conventional signal a Deluge Form Handler forwards, but it is NOT
 * required — a non-empty values object alone is sufficient (and a
 * `handler:"form"` with NO submitted values is NOT recognized, since it
 * carries no agent-readable content; the message path drops it as empty
 * text). This keeps detection consistent with {@link parseCliqFormSubmission},
 * which returns null for the same degenerate case.
 */
export function isCliqFormPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const payload = raw as CliqFormWebhookPayload;
  const values = resolveFormValues(payload);
  if (values === undefined) return false;
  return Object.keys(values).length > 0;
}

/**
 * Resolve the submitted values object from a raw payload, tolerating the
 * `values` / `form.values` / `form_data` / `formvalues` placements and the
 * `params` wrapper. Returns the first non-empty plain object found, or
 * `undefined`.
 */
function resolveFormValues(
  payload: CliqFormWebhookPayload,
): Record<string, unknown> | undefined {
  const candidates: Array<Record<string, unknown> | undefined> = [
    payload.values,
    payload.form?.values,
    payload.form_data,
    payload.formvalues,
    payload.params?.values,
    payload.params?.form?.values,
    payload.params?.form_data,
    payload.params?.formvalues,
  ];
  for (const c of candidates) {
    if (
      c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      Object.keys(c).length > 0
    ) {
      return c;
    }
  }
  return undefined;
}

/**
 * Resolve the form display name from a raw payload, tolerating `form.name` /
 * `form.link_name` / `form_name` / `params.form.name`. Returns the first
 * non-empty trimmed string, or `undefined`.
 */
function resolveFormName(payload: CliqFormWebhookPayload): string | undefined {
  const candidates: Array<string | undefined> = [
    payload.form?.name,
    payload.form?.link_name,
    payload.form_name,
    payload.params?.form?.name,
    payload.params?.form?.link_name,
    payload.params?.form_name,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

/**
 * Coerce a single form field value to a display string. Handles:
 *  - primitives (string / number / boolean) → `String(value)`
 *  - arrays → comma-joined element strings (each element recursively coerced)
 *  - `{ label, value }` Cliq dropdown objects → `label` (falls back to `value`)
 *  - other objects → `JSON.stringify` (best-effort, never throws)
 * `null` / `undefined` → empty string.
 */
export function normalizeCliqFormValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v) => normalizeCliqFormValue(v))
      .filter((s) => s.length > 0)
      .join(", ");
  }
  if (typeof value === "object") {
    // Cliq dropdown / radio convention: `{ label, value }`.
    const rec = value as { label?: unknown; value?: unknown };
    if (typeof rec.label === "string" && rec.label.trim()) return rec.label.trim();
    if (rec.value !== undefined && rec.value !== null) {
      const s = normalizeCliqFormValue(rec.value);
      if (s) return s;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

/**
 * Render a form submission as the agent-readable plain-text body. Each field
 * renders as `<key>: <normalized value>` on its own line (empty values are
 * omitted). A known form name is prefixed as a `Form: <name>` header line;
 * when the name is absent the fields render with no header. The output is
 * always non-empty when at least one field has a non-empty value (a form
 * with all-empty values renders as just the header, or `""` when nameless).
 */
export function formatCliqFormBody(submission: {
  formName?: string;
  values: Record<string, unknown>;
}): string {
  const lines: string[] = [];
  if (submission.formName) {
    lines.push(`Form: ${submission.formName}`);
  }
  for (const [key, raw] of Object.entries(submission.values)) {
    const display = normalizeCliqFormValue(raw);
    if (!display) continue;
    lines.push(`${key}: ${display}`);
  }
  return lines.join("\n");
}

/**
 * Parse a raw Cliq Form submission webhook payload into a normalized
 * {@link CliqFormSubmission}. Returns `null` when the payload carries no
 * resolvable values object (nothing to dispatch). The `body` field is the
 * agent-readable rendering (see {@link formatCliqFormBody}); it may be empty
 * when the form had a name but no populated fields (a degenerate case — the
 * caller should still treat it as "no body" and drop the turn).
 */
export function parseCliqFormSubmission(
  raw: unknown,
): CliqFormSubmission | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as CliqFormWebhookPayload;
  const values = resolveFormValues(payload);
  if (!values) return null;
  const formName = resolveFormName(payload);
  const body = formatCliqFormBody({ formName, values });
  // A submission whose body has no populated field line (a nameless form with
  // all-empty values, OR a named form whose every field rendered empty) carries
  // no agent-readable content — drop it rather than dispatch an empty turn.
  // A named form with all-empty values renders only a `Form: <name>` header
  // line; that is also dropped (no field actually carried data).
  const hasField = Object.values(values).some(
    (v) => normalizeCliqFormValue(v).length > 0,
  );
  if (!hasField) return null;
  return { formName, values, body };
}
