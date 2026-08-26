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
