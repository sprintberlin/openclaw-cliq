import { resolveRunDetachedWebhookWork, type RunDetachedWebhookWorkFn } from "./sdk-compat.js";

/**
 * Test override for the resolved detached-work helper. `undefined` means "not
 * overridden" (resolve through the SDK); `null` pins the absent-helper
 * behaviour of the pinned floor version `2026.7.1-2`.
 */
let overrideForTest: RunDetachedWebhookWorkFn | null | undefined;

/**
 * Resolve the helper that keeps ack-first webhook processing admitted after
 * the HTTP response is written (issue #122).
 *
 * On `>= 2026.8.1-beta.3` this is the SDK's `runDetachedWebhookWork`; on
 * `2026.7.1-2` no such symbol exists and this resolves to `null`, so the
 * caller keeps the plain fire-and-forget dispatch that version accepts. The
 * lookup is a dynamic namespace access in `src/sdk-compat.ts`, never a static
 * named import, so a missing export cannot break plugin load.
 */
export async function resolveCliqDetachedWebhookWork(): Promise<RunDetachedWebhookWorkFn | null> {
  if (overrideForTest !== undefined) return overrideForTest;
  return await resolveRunDetachedWebhookWork();
}

/**
 * Test helper: pin the detached-work helper (or `null` to simulate the floor
 * version). Pass `undefined` to restore SDK resolution.
 */
export function setCliqDetachedWebhookWorkForTest(
  fn: RunDetachedWebhookWorkFn | null | undefined,
): void {
  overrideForTest = fn;
}
