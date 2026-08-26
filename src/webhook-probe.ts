/**
 * Non-dispatching webhook probe for the public `/cliq/webhook` endpoint
 * (issue #96).
 *
 * The preflight has to prove that a *real* Zoho request would reach the
 * plugin: public DNS, TLS, the reverse proxy / tunnel, the route itself, and
 * the shared-secret check. The only honest way to prove that is to send a
 * real authenticated POST to the real route.
 *
 * A malformed authenticated production payload would technically do that (it
 * reaches secret verification and then fails parsing with a 400), but it is a
 * bad long-term health protocol: it asserts a *failure* mode, so it is
 * indistinguishable from a genuine parser regression, and it depends on the
 * message parser rejecting the payload forever. Instead this module defines a
 * dedicated, explicitly recognizable probe envelope that the webhook handler
 * routes BEFORE any inbound dispatch path.
 *
 * The probe therefore never creates an agent turn, session entry, outbound
 * reply, or user-visible Cliq message — the handler answers it directly and
 * returns. `dispatched: false` is part of the response contract so a caller
 * (setup, doctor, or a test) can assert the no-dispatch guarantee from the
 * response alone.
 *
 * The marker lives in the same `handler` field Cliq's Deluge handlers use
 * (`message` / `mention` / `welcome`), so it cannot collide with a real
 * event: Zoho never sends `handler: "openclaw-probe"`.
 */

/** The `handler` marker that identifies a preflight probe payload. */
export const CLIQ_PROBE_HANDLER = "openclaw-probe";

/** A parsed probe payload. */
export interface CliqProbePayload {
  /** Caller-supplied correlation nonce; empty string when absent/non-string. */
  nonce: string;
}

/** The JSON body the probe sends to `POST /cliq/webhook`. */
export interface CliqProbeBody extends Record<string, unknown> {
  handler: string;
  probe: string;
}

/** The JSON body the webhook answers a probe with. */
export interface CliqProbeResponse {
  ok: true;
  channel: "cliq";
  probe: string;
  botId: string;
  /**
   * Always `false`. The probe terminates before the inbound dispatch path,
   * so a caller can assert the no-dispatch guarantee from the response.
   */
  dispatched: false;
}

/** Build the probe request body for a given correlation nonce. */
export function buildCliqProbeBody(nonce: string): CliqProbeBody {
  return { handler: CLIQ_PROBE_HANDLER, probe: nonce };
}

function readHandlerMarker(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const handler = (raw as { handler?: unknown }).handler;
  if (typeof handler !== "string") return null;
  return handler.trim().toLowerCase();
}

/**
 * Detect whether a raw webhook payload is a preflight probe. Must be checked
 * before the welcome/message paths so a probe can never reach dispatch.
 */
export function isCliqProbePayload(raw: unknown): boolean {
  return readHandlerMarker(raw) === CLIQ_PROBE_HANDLER;
}

/**
 * Parse a raw probe payload. Returns `null` when the payload is not a probe.
 * A non-string `probe` value is normalized to an empty nonce so the handler
 * never echoes attacker-controlled structured data back in its response.
 */
export function parseCliqProbePayload(raw: unknown): CliqProbePayload | null {
  if (!isCliqProbePayload(raw)) return null;
  const probe = (raw as { probe?: unknown }).probe;
  return { nonce: typeof probe === "string" ? probe : "" };
}

/**
 * Build the probe response. Carries only non-sensitive identifying data (the
 * channel id and the configured bot id) plus the echoed nonce — never the
 * webhook secret, OAuth credentials, or any message content.
 */
export function buildCliqProbeResponse(params: {
  nonce: string;
  botId: string;
}): CliqProbeResponse {
  return {
    ok: true,
    channel: "cliq",
    probe: params.nonce,
    botId: params.botId,
    dispatched: false,
  };
}
