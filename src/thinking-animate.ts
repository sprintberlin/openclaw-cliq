/**
 * Animated "thinking" placeholder (issue #86).
 *
 * Cliq has no native typing indicator; the plugin simulates one by posting a
 * placeholder and editing it into the reply. This module optionally cycles the
 * placeholder through a set of text frames on an interval (via the existing
 * `editMessage` path) while the agent turn runs, then the caller stops the
 * animation the moment the reply arrives and does the final edit-into-reply.
 *
 * Rate-limit safety: the interval is hard-floored (≥ 800 ms) and the total
 * animation duration is capped (default 60 s) so a very long agent turn does
 * not hammer the edit endpoint — past the cap the animation stops advancing and
 * holds the last frame. A failed frame edit stops the animation but never
 * breaks the turn (the reply is still delivered). Only one animation runs per
 * in-flight message: the caller holds a single {@link ThinkingAnimation} ref
 * and calls `stop()` before the final edit-into-reply.
 */
import type { CliqClient } from "./client.js";
import {
  DEFAULT_CLIQ_THINKING_ANIMATE_INTERVAL_MS,
  MAX_CLIQ_THINKING_ANIMATE_DURATION_MS,
  MIN_CLIQ_THINKING_ANIMATE_INTERVAL_MS,
  type CliqThinkingAnimateMode,
} from "./client.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_LABEL = "thinking…";
const DOTS_FRAMES = ["💭 .", "💭 ..", "💭 ..."];

/**
 * Resolve the frame list for a given animate mode. Returns `null` when no
 * animation should run (mode `"off"`, or `"custom"` with no usable frames).
 * A single-frame list also yields `null` (nothing to cycle).
 */
export function resolveThinkingFrames(
  mode: CliqThinkingAnimateMode,
  customFrames?: readonly string[],
): string[] | null {
  switch (mode) {
    case "dots":
      return DOTS_FRAMES;
    case "spinner":
      return SPINNER_FRAMES.map((f) => `${f} ${SPINNER_LABEL}`);
    case "custom": {
      const frames = (customFrames ?? []).filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      );
      return frames.length > 1 ? frames : null;
    }
    case "off":
    default:
      return null;
  }
}

export interface ThinkingAnimation {
  /** Stop the animation timer (idempotent). Safe to call from any path. */
  stop: () => void;
}

export interface StartThinkingAnimationOptions {
  client: Pick<CliqClient, "editMessage" | "resolveChannelChatId">;
  draft: { messageId: string; chatId?: string };
  /** Raw Cliq id the placeholder was addressed to (channel unique name for groups). */
  to: string;
  /** Whether the placeholder was a DM (carries a chatId) or a group post. */
  isDm: boolean;
  mode: CliqThinkingAnimateMode;
  frames?: readonly string[];
  intervalMs?: number;
  maxDurationMs?: number;
  onError?: (err: unknown, info: { kind: string }) => void;
  /**
   * Optional scheduler (defaults to global `setTimeout`/`clearTimeout`).
   * Provided so tests can drive frames deterministically without real timers.
   */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    now: () => number;
  };
}

/**
 * Start a thinking-placeholder animation. Returns `null` when no animation
 * should run (mode off, no usable frames, or a single frame). The returned
 * {@link ThinkingAnimation.stop} cancels the pending timer and is idempotent —
 * the caller MUST call it before the final edit-into-reply so a late frame
 * edit does not clobber the reply.
 *
 * The animation advances one frame per `intervalMs` (hard-floored to
 * {@link MIN_CLIQ_THINKING_ANIMATE_INTERVAL_MS}) via a recursive `setTimeout`
 * (so ticks never overlap — a slow edit delays the next frame, never stacks).
 * After {@link MAX_CLIQ_THINKING_ANIMATE_DURATION_MS} the animation stops
 * advancing and holds the last frame. The chat id is resolved lazily for group
 * posts (the placeholder send response carries no chatId); if resolution fails
 * the animation stops (the placeholder stays on its last frame, the reply is
 * still delivered). A failed frame edit is reported via `onError` and stops
 * the animation.
 */
export function startThinkingAnimation(
  opts: StartThinkingAnimationOptions,
): ThinkingAnimation | null {
  const frames = resolveThinkingFrames(opts.mode, opts.frames);
  if (!frames) return null;

  const intervalMs = Math.max(
    MIN_CLIQ_THINKING_ANIMATE_INTERVAL_MS,
    opts.intervalMs ?? DEFAULT_CLIQ_THINKING_ANIMATE_INTERVAL_MS,
  );
  const maxDurationMs = opts.maxDurationMs ?? MAX_CLIQ_THINKING_ANIMATE_DURATION_MS;
  const scheduler = opts.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };

  let stopped = false;
  let handle: unknown | null = null;
  let frameIndex = 0;
  let chatIdResolved = opts.draft.chatId;
  let chatIdResolveAttempted = Boolean(chatIdResolved);
  const startedAt = scheduler.now();

  const resolveChatId = async (): Promise<string | undefined> => {
    if (chatIdResolved) return chatIdResolved;
    if (chatIdResolveAttempted) return undefined;
    chatIdResolveAttempted = true;
    if (opts.isDm) return undefined;
    try {
      chatIdResolved = (await opts.client.resolveChannelChatId(opts.to)) ?? undefined;
    } catch {
      chatIdResolved = undefined;
    }
    return chatIdResolved;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (handle !== null) {
      scheduler.clearTimeout(handle);
      handle = null;
    }
  };

  const runFrame = async (): Promise<void> => {
    if (stopped) return;
    // Cap total duration: stop advancing after the cap, hold the last frame.
    if (scheduler.now() - startedAt >= maxDurationMs) {
      stop();
      return;
    }
    frameIndex = (frameIndex + 1) % frames.length;
    const chatId = await resolveChatId();
    if (!chatId) {
      // Cannot edit without a chat id — stop animating (don't break the turn).
      stop();
      return;
    }
    if (stopped) return; // stopped while awaiting chat-id resolution
    try {
      await opts.client.editMessage({
        chatId,
        messageId: opts.draft.messageId,
        text: frames[frameIndex],
      });
    } catch (err) {
      // A failed frame edit stops the animation but never breaks the turn.
      opts.onError?.(err, { kind: "thinking-animate-frame" });
      stop();
      return;
    }
    if (stopped) return;
    // Schedule the next frame (recursive so ticks never overlap).
    handle = scheduler.setTimeout(runFrame, intervalMs);
  };

  // First advance after one interval (the placeholder itself is frame 0).
  handle = scheduler.setTimeout(runFrame, intervalMs);

  return { stop };
}
