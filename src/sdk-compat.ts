/**
 * The single place where "OpenClaw SDK surface that differs across supported
 * versions" is resolved.
 *
 * A **static named import** of an SDK symbol is validated by Node at module
 * evaluation time. If a supported OpenClaw version does not export that
 * symbol, the import throws `SyntaxError: The requested module ... does not
 * provide an export named ...` *before any of our code runs* — the whole
 * plugin fails to load, not just the affected feature. Anything that is not
 * exported by every supported version must therefore be reached through a
 * dynamic `import()` and namespace property access, so a missing export
 * degrades to `undefined` instead of killing the plugin.
 *
 * Supported range today: `2026.7.1-2` (the build/typecheck floor) through
 * `2026.8.1-beta.3`.
 */

/**
 * Structural type for the SDK's pairing-approve helper.
 *
 * Deliberately NOT `typeof approveChannelPairingCode` — that symbol does not
 * exist on every supported version, and a `typeof` reference would require
 * importing it.
 */
export type ChannelPairingApproveFn = (params: {
  channel: string;
  code: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<{ id: string; meta?: Record<string, string> } | null>;

/** Module-level memo — this resolves on the inbound webhook path. */
let approveResolution: Promise<ChannelPairingApproveFn | null> | undefined;

async function loadChannelPairingApprove(): Promise<ChannelPairingApproveFn | null> {
  try {
    const ns: Record<string, unknown> = await import(
      "openclaw/plugin-sdk/conversation-runtime"
    );
    const candidate = ns["approveChannelPairingCode"];
    if (typeof candidate !== "function") {
      return null;
    }
    return candidate as ChannelPairingApproveFn;
  } catch {
    return null;
  }
}

/**
 * Resolve the SDK's pairing-approve helper when the running OpenClaw version
 * still exports it (`<= 2026.7.x`), else `null` (`>= 2026.8.1-beta.3`, where
 * `openclaw/plugin-sdk/conversation-runtime` narrowed its re-export of the
 * pairing store to `readChannelAllowFromStore` + `upsertChannelPairingRequest`).
 *
 * Never throws: a failed import, a missing property, or a non-function
 * property all resolve to `null`. The result is memoized.
 */
export function resolveChannelPairingApprove(): Promise<ChannelPairingApproveFn | null> {
  approveResolution ??= loadChannelPairingApprove();
  return approveResolution;
}

/**
 * Structural type for the SDK's "channel is ready" status-patch builder.
 *
 * Deliberately NOT `typeof channelReadyPatch`: the symbol only exists on
 * newer OpenClaw versions, and a `typeof` reference would require importing
 * it, which is exactly the load-time hazard this module exists to avoid.
 */
export type ChannelReadyPatchFn = (
  extras?: Record<string, unknown>,
) => Record<string, unknown>;

/** Module-level memo — resolved once per process on the startup path. */
let readyPatchResolution: Promise<ChannelReadyPatchFn | null> | undefined;

async function loadChannelReadyPatch(): Promise<ChannelReadyPatchFn | null> {
  try {
    const ns: Record<string, unknown> = await import(
      "openclaw/plugin-sdk/gateway-runtime"
    );
    const candidate = ns["channelReadyPatch"];
    if (typeof candidate !== "function") {
      return null;
    }
    return candidate as ChannelReadyPatchFn;
  } catch {
    return null;
  }
}

/**
 * Resolve the SDK's `channelReadyPatch` helper when the running OpenClaw
 * version exports it (`>= 2026.8.1-beta.3`), else `null` (`2026.7.x`, which
 * has no `lifecycle` field at all).
 *
 * Newer gateways set `lifecycle: "starting"` before handing off to
 * `gateway.startAccount` and expect the channel to advance it; this helper is
 * how a channel says "ready". Never throws — a failed import, a missing
 * property, or a non-function property all resolve to `null`, and the caller
 * falls back to a plain running/connected patch that every supported version
 * understands. The result is memoized.
 */
export function resolveChannelReadyPatch(): Promise<ChannelReadyPatchFn | null> {
  readyPatchResolution ??= loadChannelReadyPatch();
  return readyPatchResolution;
}

export type InboundProcessedOutcome = {
  outcome: string;
  reason?: string;
};

export type InboundProcessedOutcomeReaderFn = (
  result: unknown,
) => InboundProcessedOutcome | null | undefined;

let inboundProcessedOutcomeResolution:
  | Promise<InboundProcessedOutcomeReaderFn | null>
  | undefined;

function asProcessedOutcome(value: unknown): InboundProcessedOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.outcome !== "string") return null;
  return {
    outcome: record.outcome,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

async function loadInboundProcessedOutcomeReader(): Promise<InboundProcessedOutcomeReaderFn | null> {
  try {
    const ns: Record<string, unknown> = await import(
      "openclaw/plugin-sdk/channel-inbound"
    );
    for (const name of [
      "readInboundProcessedOutcome",
      "readChannelTurnProcessedOutcome",
      "resolveInboundProcessedOutcome",
    ]) {
      const candidate = ns[name];
      if (typeof candidate === "function") {
        return candidate as InboundProcessedOutcomeReaderFn;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveInboundProcessedOutcomeReader(): Promise<InboundProcessedOutcomeReaderFn | null> {
  inboundProcessedOutcomeResolution ??= loadInboundProcessedOutcomeReader();
  return inboundProcessedOutcomeResolution;
}

export async function readInboundProcessedOutcome(
  result: unknown,
): Promise<InboundProcessedOutcome | null> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const direct = asProcessedOutcome(record.processedOutcome);
    if (direct) return direct;
    const dispatchResult = record.dispatchResult;
    if (
      dispatchResult &&
      typeof dispatchResult === "object" &&
      !Array.isArray(dispatchResult)
    ) {
      const nested = asProcessedOutcome(
        (dispatchResult as Record<string, unknown>).processedOutcome,
      );
      if (nested) return nested;
    }
  }
  const reader = await resolveInboundProcessedOutcomeReader();
  if (!reader) return null;
  try {
    return asProcessedOutcome(reader(result));
  } catch {
    return null;
  }
}

/**
 * Structural type for the SDK's detached-webhook-work helper.
 *
 * Deliberately NOT `typeof runDetachedWebhookWork`: the symbol only exists on
 * `>= 2026.8.1-beta.3`, and a `typeof` reference would require importing it.
 */
export type RunDetachedWebhookWorkFn = <T>(work: () => Promise<T>) => Promise<T>;

/** Module-level memo — resolved once per process on the inbound webhook path. */
let runDetachedResolution: Promise<RunDetachedWebhookWorkFn | null> | undefined;

async function loadRunDetachedWebhookWork(): Promise<RunDetachedWebhookWorkFn | null> {
  try {
    const ns: Record<string, unknown> = await import(
      "openclaw/plugin-sdk/webhook-request-guards"
    );
    const candidate = ns["runDetachedWebhookWork"];
    if (typeof candidate !== "function") {
      return null;
    }
    return candidate as RunDetachedWebhookWorkFn;
  } catch {
    return null;
  }
}

/**
 * Resolve the SDK's `runDetachedWebhookWork` helper when the running OpenClaw
 * version exports it (`>= 2026.8.1-beta.3`), else `null` (`2026.7.1-2`).
 *
 * An ack-first webhook handler responds before its processing finishes, so the
 * continued work outlives the HTTP request admission it inherited. Once that
 * admission is released, queue enqueues from the inherited chain are refused
 * as if the gateway were draining — which is why `ackPolicy: "immediate"`
 * failed every turn with `GatewayDrainingError` on beta.3. This helper
 * reserves an independent root that keeps the detached processing accepted,
 * and must be called synchronously from the request handler while the request
 * is still admitted.
 *
 * Never throws: a failed import, a missing property, or a non-function
 * property all resolve to `null`, and the caller falls back to the plain
 * fire-and-forget dispatch that `2026.7.1-2` accepts. The result is memoized.
 */
export function resolveRunDetachedWebhookWork(): Promise<RunDetachedWebhookWorkFn | null> {
  runDetachedResolution ??= loadRunDetachedWebhookWork();
  return runDetachedResolution;
}
