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
