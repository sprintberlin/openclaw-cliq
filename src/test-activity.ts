/**
 * In-memory stand-in for OpenClaw's channel-activity store, used by tests.
 *
 * OpenClaw 2026.10.2 no longer exports `getChannelActivity` from any public
 * `plugin-sdk` subpath (only `recordChannelActivity` via
 * `channel-activity-runtime`). Tests mock that subpath with this module so the
 * plugin's own recording calls stay observable. The real SDK module is
 * covered by `npm run check:sdk-compat` and `npm run smoke:gateway`.
 * Test-only: excluded from the published build.
 */
interface ActivityEntry {
  inboundAt: number | null;
  outboundAt: number | null;
}

const store = new Map<string, ActivityEntry>();

function keyFor(params: { channel: string; accountId?: string | null }): string {
  return `${params.channel}:${params.accountId?.trim() || "default"}`;
}

export function recordChannelActivity(params: {
  channel: string;
  accountId?: string | null;
  direction: "inbound" | "outbound";
  at?: number;
}): void {
  const key = keyFor(params);
  const entry = store.get(key) ?? { inboundAt: null, outboundAt: null };
  store.set(key, entry);
  const at = typeof params.at === "number" ? params.at : Date.now();
  if (params.direction === "inbound") entry.inboundAt = at;
  else entry.outboundAt = at;
}

export function getChannelActivity(params: {
  channel: string;
  accountId?: string | null;
}): ActivityEntry {
  return store.get(keyFor(params)) ?? { inboundAt: null, outboundAt: null };
}
