/**
 * Versioned contract for the generated Zoho Deluge inbound handlers (issue #228).
 *
 * A bot handler is stored and executed by Zoho, independently from the plugin
 * artifact. A static payload marker lets read-back diagnostics distinguish a
 * currently generated script from an older otherwise-recognisable one without
 * executing or logging the script. The marker is deliberately a string literal
 * in `payload.put(...)`: declaring or assigning a new Deluge variable would
 * widen the validation surface, while `execution_handler_update_failed` is a
 * permanent script-validity failure rather than a retryable transport error.
 */

/** Payload key emitted by every generated Message, Mention, and Welcome handler. */
export const CLIQ_HANDLER_SCHEMA_FIELD = "handlerSchema";

/**
 * Current generated-handler payload contract.
 *
 * `v1` was the unmarked historical shape. `v2` adds only this marker; its
 * message remains the verified bare Message/Mention-handler string rather
 * than assuming unverified rich Deluge variables exist.
 */
export const CLIQ_HANDLER_SCHEMA_VERSION = "v2";

export type CliqHandlerSchemaCompatibility = "current" | "missing" | "unsupported";

/** Classify an inbound marker without rejecting an older payload. */
export function classifyCliqHandlerSchema(value: unknown): CliqHandlerSchemaCompatibility {
  if (typeof value !== "string" || !value.trim()) return "missing";
  return value.trim() === CLIQ_HANDLER_SCHEMA_VERSION ? "current" : "unsupported";
}

/**
 * Extract a generated `payload.put("key", "value")` literal from a script.
 *
 * The line anchor intentionally rejects comments and computed Deluge values:
 * a diagnostics pass may call a hand-written handler "unrecognised", but it
 * must never mistake a comment for proof of a live contract.
 */
export function extractDelugePayloadPutStringLiteral(
  script: string,
  key: string,
): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^[ \\t]*payload[ \\t]*\\.[ \\t]*put[ \\t]*\\([ \\t]*"${escapedKey}"[ \\t]*,[ \\t]*"([^"\\n]*)"[ \\t]*\\)[ \\t]*;`,
    "m",
  );
  const match = pattern.exec(script);
  return match ? (match[1] ?? null) : null;
}

/** Process-local once keys; version lag is informational, never a reject. */
const warnedSchemaVersions = new Set<string>();

function safeObservedVersion(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "unversioned";
  const version = value.trim();
  // A schema identifier is handler-controlled, but do not make logs a place
  // for arbitrary webhook values if somebody hand-writes an odd handler.
  return /^v[0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(version)
    ? version
    : "unrecognised";
}

/**
 * Emit one value-free compatibility warning for each observed stale version.
 *
 * An old handler must keep delivering ordinary text: Doctor/provisioning own
 * repair, while runtime warns until the Zoho-held script is updated. The set
 * intentionally lives only in process memory, so a gateway restart produces
 * one fresh, useful reminder instead of persisting a hidden state file.
 */
export function warnCliqHandlerSchemaCompatibility(
  value: unknown,
  warn: ((message: string) => void) | undefined,
): void {
  if (!warn || classifyCliqHandlerSchema(value) === "current") return;
  const observed = safeObservedVersion(value);
  if (warnedSchemaVersions.has(observed)) return;
  warnedSchemaVersions.add(observed);
  warn(
    `[cliq] inbound handler schema ${observed} is stale; expected ${CLIQ_HANDLER_SCHEMA_VERSION}. Payload accepted for compatibility. Run openclaw setup (or the confirmation-gated handler repair) to update Zoho's stored handler script.`,
  );
}

/** Test-only reset for deterministic process-local warning assertions. */
export function resetCliqHandlerSchemaWarningsForTest(): void {
  warnedSchemaVersions.clear();
}
