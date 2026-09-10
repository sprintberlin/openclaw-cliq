/**
 * Animated "thinking" placeholder (issue #86).
 *
 * Native v3 typing is a separate capability (issue #178); this module still
 * cycles a visible in-chat placeholder because Cliq client UI for typing is
 * unconfirmed. This module optionally cycles the
 * placeholder through a set of text frames on an interval (via the existing
 * `editMessage` path) while the agent turn is silent, then the caller quenches
 * and drains it before the first real reply/progress edit.
 *
 * Rate-limit safety: the interval is hard-floored (≥ 800 ms) and the total
 * animation duration is capped (default 60 s) so a very long agent turn does
 * not hammer the edit endpoint — past the cap the animation stops advancing and
 * holds the last frame. A failed frame edit stops the animation but never
 * breaks the turn (the reply is still delivered). Only one animation runs per
 * in-flight message: the caller holds a single {@link ThinkingAnimation} ref
 * and awaits `stop()` before the first real reply/progress edit. The stop
 * drains a frame PUT already in flight, so the real edit is ordered after the
 * final animation frame (issues #184, #211).
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
  /** Stop the timer and drain an in-flight frame edit (idempotent). */
  stop: () => Promise<void>;
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
 * {@link ThinkingAnimation.stop} cancels the pending timer, drains an edit
 * already in flight, and is idempotent. The caller MUST await it before the
 * first real reply/progress edit so a late frame edit cannot clobber the
 * growing draft.
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
  let frameInFlight: Promise<void> | null = null;
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

  const markStopped = (): void => {
    stopped = true;
    if (handle === null) return;
    scheduler.clearTimeout(handle);
    handle = null;
  };

  const stop = async (): Promise<void> => {
    markStopped();
    const pending = frameInFlight;
    if (pending) await pending;
  };

  const runFrame = async (): Promise<void> => {
    if (stopped) return;
    // Cap total duration: stop advancing after the cap, hold the last frame.
    if (scheduler.now() - startedAt >= maxDurationMs) {
      markStopped();
      return;
    }
    frameIndex = (frameIndex + 1) % frames.length;
    const chatId = await resolveChatId();
    if (!chatId) {
      // Cannot edit without a chat id — stop animating (don't break the turn).
      markStopped();
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
      markStopped();
      return;
    }
    if (stopped) return;
    // Schedule the next frame (recursive so ticks never overlap).
    scheduleNext();
  };

  const scheduleNext = (): void => {
    handle = scheduler.setTimeout(() => {
      handle = null;
      const pending = runFrame();
      frameInFlight = pending;
      void pending.finally(() => {
        if (frameInFlight === pending) frameInFlight = null;
      });
    }, intervalMs);
  };

  // First advance after one interval (the placeholder itself is frame 0).
  scheduleNext();

  return { stop };
}
