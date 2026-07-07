/**
 * Zoho Cliq error-envelope parsing.
 *
 * v3 returns a consistent JSON error envelope on every non-2xx:
 *   `{"message":"…"}`
 * (the v3 Errors docs list only a top-level `message` field; some endpoints
 * add `code`/`details`, but `message` is always the human-readable string).
 * v2 returns a mix of opaque strings and ad-hoc JSON shapes.
 *
 * This module extracts the human-readable message from either shape so error
 * classification (`src/send-retry.ts`) and the data-center hint
 * (`src/region.ts`) can match patterns against the *message text* rather than
 * the raw (possibly JSON-stringified) body. Without this, a v3 401 such as
 * `{"message":"Request was rejected because of invalid AuthToken."}` would
 * NOT match the existing `/invalid_token/` or `/unauthorized/` auth-failure
 * patterns (the substring inside the JSON is `invalid AuthToken`, not
 * `invalid_token`), so a non-EU account hitting the EU endpoints via a v3
 * endpoint would get an opaque error with no data-center pointer.
 *
 * The parser is intentionally permissive: any body that is not a JSON object
 * with a string `message` field falls back to the raw body, so v2 responses
 * and non-JSON bodies are passed through unchanged.
 */

export interface ParsedCliqError {
  /** The raw response body, unchanged. */
  readonly raw: string;
  /**
   * The human-readable message: the `message` field from a v3 envelope, or
   * the raw body when the body is not a v3 envelope.
   */
  readonly message: string;
  /** `true` when the body parsed as a JSON object with a string `message`. */
  readonly isV3Envelope: boolean;
}

/**
 * Extract the human-readable message from a Cliq error response body.
 * Never throws — a parse failure or non-JSON body yields `{ raw, message: raw,
 * isV3Envelope: false }`.
 */
export function parseCliqErrorBody(raw: string): ParsedCliqError {
  if (!raw) return { raw, message: raw, isV3Envelope: false };
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return { raw, message: raw, isV3Envelope: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { raw, message: raw, isV3Envelope: false };
    }
    const msg = (parsed as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) {
      return { raw, message: msg, isV3Envelope: true };
    }
  } catch {
    // not JSON — pass through
  }
  return { raw, message: raw, isV3Envelope: false };
}
