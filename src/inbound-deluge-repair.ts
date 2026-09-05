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
 * the **last** occurrence of `","user":` in the body: free text that itself
 * contains that literal sits *before* the real boundary, so `lastIndexOf`
 * finds the real one and the literal stays part of the message text.
 *
 * The message text is re-escaped with `JSON.stringify` and the body is parsed
 * again. Returns `undefined` whenever the body does not match the generated
 * shape or the repaired form still fails to parse — the caller then falls
 * through to the existing reject path with its skip logging (issue #232).
 */

const VALUE_START = /^\{\s*"handler"\s*:\s*"(?:message|mention|dm)"\s*,\s*"message"\s*:\s*"/;

const TAIL_BOUNDARY = '","user":';

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
  const boundary = after.lastIndexOf(TAIL_BOUNDARY);
  if (boundary <= 0) return undefined;

  const rawText = after.slice(0, boundary);
  const tail = after.slice(boundary + 1); // starts with `,"user":`
  const repaired =
    body.slice(0, start[0].length - 1) + // up to (not incl.) the value's opening quote
    JSON.stringify(rawText) +
    tail;
  try {
    const value: unknown = JSON.parse(repaired);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A content-free fingerprint of an unparseable body: letters and digits are
 * masked to `x*`, punctuation, quotes and (marked) line breaks stay. This
 * identifies the *syntax* of a corrupt payload (unescaped quotes vs. Deluge
 * `a=b` map syntax vs. truncated body) without exposing any user text, so the
 * next unknown corruption documents itself in the default-visible skip line.
 */
export function describeDelugeBodySyntax(raw: string, maxLen = 96): string {
  const masked = raw
    .replace(/\r/g, "")
    .replace(/\n/g, "⏎")
    .replace(/[^\s⏎]/g, (ch) => (/[A-Za-z0-9]/.test(ch) ? "x" : ch))
    .replace(/x{2,}/g, "x*")
    .replace(/\s+/g, " ");
  return masked.slice(0, maxLen);
}
