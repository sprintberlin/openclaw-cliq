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

/**
 * Parse a Deluge `Map.toString()` literal (issue #273).
 *
 * The attachment branch of the generated Message handler posts
 * `payload.toString()`. For a map whose values are themselves maps or lists,
 * Deluge does not emit JSON at all — it emits its own literal form with bare
 * keys and `=` instead of `"key":`:
 *
 * ```text
 * {handler=message, handlerSchema=v4, message=, user={id=20108735584,
 *  name=Dominic Offers}, chat={id=CT_dm}, attachments=[voice.wav]}
 * ```
 *
 * `JSON.parse` rejects this outright, and the grammar-keyed quote/newline
 * repair above does not apply because there are no quotes to rebalance. A
 * voice note therefore lost its whole request — payload *and* the already
 * received audio bytes — at the multipart payload part.
 *
 * Values stay strings: Deluge erases the original type in `toString()`, and
 * the inbound contract only requires `user.id` and `chat.id` to be readable.
 * Nothing is coerced to a number, so an id can never lose precision.
 */
export function parseDelugeMapLiteral(raw: string): unknown | undefined {
  const body = raw.trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return undefined;
  // A JSON body is never ours: the caller already tried, and a quoted-key
  // object must not be re-read by this looser grammar.
  if (/^\{\s*"/.test(body)) return undefined;
  if (!body.includes("=")) return undefined;

  let pos = 0;

  const skipSpace = () => {
    while (pos < body.length && /\s/.test(body[pos] ?? "")) pos += 1;
  };

  const parseScalar = (): string => {
    const start = pos;
    while (pos < body.length && ![",", "}", "]"].includes(body[pos] ?? "")) pos += 1;
    return body.slice(start, pos).trim();
  };

  const parseValue = (depth: number): unknown | undefined => {
    if (depth > 16) return undefined;
    skipSpace();
    const char = body[pos];
    if (char === "{") return parseMap(depth + 1);
    if (char === "[") return parseList(depth + 1);
    return parseScalar();
  };

  const parseList = (depth: number): unknown[] | undefined => {
    if (body[pos] !== "[") return undefined;
    pos += 1;
    const items: unknown[] = [];
    for (;;) {
      skipSpace();
      if (pos >= body.length) return undefined;
      if (body[pos] === "]") {
        pos += 1;
        return items;
      }
      const value = parseValue(depth);
      if (value === undefined) return undefined;
      items.push(value);
      skipSpace();
      if (body[pos] === ",") {
        pos += 1;
        continue;
      }
      if (body[pos] === "]") {
        pos += 1;
        return items;
      }
      return undefined;
    }
  };

  const parseMap = (depth: number): Record<string, unknown> | undefined => {
    if (body[pos] !== "{") return undefined;
    pos += 1;
    const map: Record<string, unknown> = {};
    for (;;) {
      skipSpace();
      if (pos >= body.length) return undefined;
      if (body[pos] === "}") {
        pos += 1;
        return map;
      }
      const keyStart = pos;
      while (pos < body.length && !["=", ",", "}"].includes(body[pos] ?? "")) pos += 1;
      if (body[pos] !== "=") return undefined;
      const key = body.slice(keyStart, pos).trim();
      if (!key) return undefined;
      pos += 1;
      const value = parseValue(depth);
      if (value === undefined) return undefined;
      map[key] = value;
      skipSpace();
      if (body[pos] === ",") {
        pos += 1;
        continue;
      }
      if (body[pos] === "}") {
        pos += 1;
        return map;
      }
      return undefined;
    }
  };

  const value = parseMap(0);
  if (value === undefined) return undefined;
  skipSpace();
  if (pos !== body.length) return undefined;

  // Accept only the generated inbound contract, never an arbitrary `a=b`
  // blob: the payload must carry routable identity, exactly like the
  // multipart field reconstruction requires.
  const user = value.user;
  const chat = value.chat;
  if (
    typeof value.message !== "string" ||
    typeof value.handler !== "string" ||
    !user ||
    typeof user !== "object" ||
    Array.isArray(user) ||
    typeof (user as Record<string, unknown>).id !== "string" ||
    !(user as Record<string, unknown>).id ||
    !chat ||
    typeof chat !== "object" ||
    Array.isArray(chat)
  ) {
    return undefined;
  }
  return value;
}

/**
 * Escape raw C0 control characters that appear *inside* JSON string literals.
 *
 * Live evidence (2026-09-19 18:50, issue #273): the attachment branch posts a
 * correctly quoted JSON payload — the masked log shape showed `{"x*":"x*",…}`,
 * not a Deluge map literal — yet `JSON.parse` still rejected it. JSON forbids
 * unescaped characters below U+0020 in a string, and Cliq lets raw CR/TAB from
 * a message or file name through verbatim. The grammar-keyed repair above does
 * not apply because the quoting itself is balanced.
 *
 * Only string interiors are touched, so structural whitespace between tokens
 * keeps its meaning and a body without such characters is left to the other
 * repairs.
 */
export function repairUnescapedControlChars(raw: string): unknown | undefined {
  const body = raw.trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return undefined;

  let out = "";
  let inString = false;
  let escaped = false;
  let changed = false;

  for (const character of body) {
    if (escaped) {
      out += character;
      escaped = false;
      continue;
    }
    if (inString && character === "\\") {
      out += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      out += character;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    if (inString && code < 0x20) {
      changed = true;
      if (code === 0x0a) out += "\\n";
      else if (code === 0x0d) out += "\\r";
      else if (code === 0x09) out += "\\t";
      else out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += character;
  }

  // An unterminated string means the body is damaged beyond this repair.
  if (!changed || inString || escaped) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

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
