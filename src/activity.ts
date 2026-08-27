import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { CLIQ_DEFAULT_ACCOUNT_ID } from "./client.js";

/**
 * Liveness tracking for the Cliq channel.
 *
 * A webhook channel has no socket whose state can stand in for "is this
 * integration alive?", so the last inbound / outbound message timestamps are
 * the only real liveness signal available. OpenClaw surfaces them as
 * `lastInboundAt` / `lastOutboundAt` on the account status snapshot, but it
 * only fills them from activity a channel explicitly records — an unreported
 * channel shows `null` forever even after a verified round-trip (issue #98).
 */

/**
 * Record one inbound or outbound event for a Cliq account.
 *
 * Never throws: liveness bookkeeping must not be able to fail a real message.
 * A `null`/blank account id is normalized to the default account id so
 * single-account installs (whose resolved `accountId` is `null`) record under
 * the same key the status surfaces read.
 */
export function recordCliqActivity(params: {
  accountId?: string | null;
  direction: "inbound" | "outbound";
  at?: number;
}): void {
  try {
    recordChannelActivity({
      channel: "cliq",
      accountId: params.accountId?.trim() || CLIQ_DEFAULT_ACCOUNT_ID,
      direction: params.direction,
      ...(params.at === undefined ? {} : { at: params.at }),
    });
  } catch {
    // Ignore: an SDK-side bookkeeping failure must never break delivery.
  }
}

/** The send methods whose success counts as outbound Cliq activity. */
const TRACKED_SEND_METHODS = [
  "sendMessage",
  "sendMediaMessage",
  "sendCard",
] as const;

type TrackedSendMethod = (typeof TRACKED_SEND_METHODS)[number];

type SendTrackable = Record<
  TrackedSendMethod,
  (...args: never[]) => Promise<unknown>
> & { [ACTIVITY_TRACKED]?: boolean };

const ACTIVITY_TRACKED = Symbol.for("cliq.activityTracked");

/**
 * Wrap a client's send methods so a *successful* send records outbound
 * activity for its account.
 *
 * Applied once per client by `CliqClientRegistry`, which is the single
 * construction site for every runtime send path (outbound replies, inbound
 * delivery, welcome greetings, pairing cards, agent message actions), so all
 * of them are covered without each caller remembering to report.
 *
 * Only successful sends count — a throw means nothing reached Cliq, and
 * recording it would make a broken integration look alive. Edits, deletes,
 * and reactions are intentionally not tracked: they follow an earlier send
 * and mirror how the bundled channels report activity.
 */
export function trackCliqOutboundActivity<T extends object>(
  client: T,
  accountId: string | null,
): T {
  const target = client as T & SendTrackable;
  if (target[ACTIVITY_TRACKED]) return client;
  for (const method of TRACKED_SEND_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = async function patched(
      this: unknown,
      ...args: never[]
    ): Promise<unknown> {
      const result = await original.apply(this, args);
      recordCliqActivity({ accountId, direction: "outbound" });
      return result;
    } as SendTrackable[TrackedSendMethod];
  }
  target[ACTIVITY_TRACKED] = true;
  return client;
}
