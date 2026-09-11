/**
 * Repair a Deluge-corrupted webhook body (issues #223 / #227).
 *
 * ## The corruption
 *
 * The generated Deluge handler posts `payload.toString()`. For a flat map of
 * strings Zoho's `toString()` emits JSON-looking text — but it does **not**
 * escape string values. A `message` containing a double quote or a line break
 * therefore produces a body like:
 *
 * ```json
 * {"handler":"message","message":"Er sagte "others"
 * und weiter","user":{...},"chat":{...},"eventId":"..."}
 * ```
 *
 * The raw quote and the raw newline inside the value make `JSON.parse` fail
 * even though the payload is structurally complete. Live evidence
 * (2026-09-05): a forwarded business instruction arrived as a 1091-byte
 * authenticated POST and died at exactly this boundary — every plain message
 * without quotes/newlines happened to parse.
 *
 * ## The repair
 *
 * We generate the handler, so the grammar is known: after
 * `"handler":"…","message":"` comes free text, and the structural tail
 * (`,"user": … }`) is machine-generated and cannot contain the literal
 * `","user":` inside its own values. The real closing boundary is therefore
 * the **last parseable generated-field separator** after the message value.
 * Deluge may vary insignificant whitespace and Map iteration order, so the
 * repair tries candidate boundaries before known generated fields from right
 * to left and accepts only one whose reconstructed suffix parses as the full
 * generated object. Free text that itself contains a separator-like literal
 * remains part of the message unless the remainder is a valid generated
 * payload.
 */

/**
 * The generated handler may emit further flat string fields between
 * `handler` and `message` — `handlerSchema` (issue #228) is the first, and a
 * future contract marker must not silently disable this repair again. Only
 * well-formed `"key":"value"` pairs whose value contains no quote, backslash
 * or line break are skipped: those are machine-generated literals, so
 * tolerating them cannot swallow corrupted free text.
 */
const VALUE_START =
  /^\{\s*"handler"\s*:\s*"(?:message|mention|dm)"\s*,\s*(?:"[A-Za-z0-9_]+"\s*:\s*"[^"\\\n]*"\s*,\s*)*"message"\s*:\s*"/;

const TAIL_BOUNDARY =
  /"\s*,\s*"(?:user|chat|eventId|event_id|attachments|mentions|channel|thread)"\s*:/g;

export function repairDelugeUnescapedMessageBody(raw: string): unknown | undefined {
  const body = raw.trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return undefined;

  // A body that already parses is not ours to repair: the caller only
  // invokes this after its own JSON.parse failed, so success here means an
  // adversarial text (containing the literal `","user":`) happened to make
  // the corrupt body parseable — the caller's reading stands. Returning
  // undefined also guarantees a clean, properly escaped body passed in by
  // mistake can never be double-escaped by the repair below.
  try {
    JSON.parse(body);
    return undefined;
  } catch {
    // fall through to repair
  }

  const start = VALUE_START.exec(body);
  if (!start) return undefined;

  const after = body.slice(start[0].length);
  const candidates = [...after.matchAll(TAIL_BOUNDARY)];
  for (const candidate of candidates.reverse()) {
    const boundary = candidate.index;
    if (boundary === undefined || boundary <= 0) continue;

    const rawText = after.slice(0, boundary);
    const tail = after.slice(boundary + 1); // preserve comma + Deluge whitespace
    const repaired =
      body.slice(0, start[0].length - 1) + // up to (not incl.) the value's opening quote
      JSON.stringify(rawText) +
      tail;
    try {
      const value: unknown = JSON.parse(repaired);
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).message === rawText &&
        typeof (value as Record<string, unknown>).user === "object" &&
        typeof (value as Record<string, unknown>).chat === "object"
      ) {
        return value;
      }
    } catch {
      // A separator-like literal inside message text is not a structural
      // boundary. Continue left until the reconstructed generated suffix
      // parses as a complete object carrying the required user/chat maps.
    }
  }
  return undefined;
}

/**
 * A content-free fingerprint of an unparseable body: letters and digits are
 * masked to `x*`, punctuation, quotes and (marked) line breaks stay. This
 * identifies the *syntax* of a corrupt payload (unescaped quotes vs. Deluge
 * `a=b` map syntax vs. truncated body) without exposing any user text, so the
 * next unknown corruption documents itself in the default-visible skip line.
 *
 * A long body keeps its **tail** as well as its head. The structural boundary
 * this repair depends on (`","user":` and the generated suffix) lives at the
 * end, so a head-only fingerprint truncates away the only evidence that
 * explains why a repair declined — exactly what happened to the 2026-09-11
 * roundtrip, where 1384 bytes were diagnosed from the first 96.
 */
export function describeDelugeBodySyntax(raw: string, maxLen = 96): string {
  const masked = raw
    .replace(/\r/g, "")
    .replace(/\n/g, "⏎")
    .replace(/[^\s⏎]/g, (ch) => (/[A-Za-z0-9]/.test(ch) ? "x" : ch))
    .replace(/x{2,}/g, "x*")
    .replace(/\s+/g, " ");
  if (masked.length <= maxLen) return masked;
  const ELLIPSIS = "…";
  // Bias toward the tail: the generated suffix is where the boundary lives.
  const tailLen = Math.floor((maxLen - ELLIPSIS.length) / 2);
  const headLen = maxLen - ELLIPSIS.length - tailLen;
  return masked.slice(0, headLen) + ELLIPSIS + masked.slice(masked.length - tailLen);
}
