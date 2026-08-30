import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCliqProgressDraftController,
  type CliqProgressDraftSink,
} from "./progress-draft.js";
import type { CliqStreamingMode } from "./client.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeController(params?: {
  mode?: CliqStreamingMode;
  sink?: CliqProgressDraftSink;
  seed?: string;
  reasoningVisible?: boolean;
  active?: boolean;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}) {
  const updates: Array<{ text: string; flush?: boolean }> = [];
  const sink: CliqProgressDraftSink =
    params?.sink ??
    (async (text, options) => {
      updates.push({ text, flush: options?.flush });
      return true;
    });
  const controller = createCliqProgressDraftController({
    mode: params?.mode ?? "progress",
    entry: { streaming: { mode: params?.mode ?? "progress", progress: {} } },
    seed: params?.seed ?? "cliq:default:u1",
    update: sink,
    active: params?.active,
    onPartialReply: async () => {
      updates.push({ text: "this must not replace the draft" });
    },
    reasoningVisible: params?.reasoningVisible,
    setTimeoutFn: params?.setTimeoutFn,
    clearTimeoutFn: params?.clearTimeoutFn,
  });
  return { controller, updates };
}

describe("createCliqProgressDraftController (issue #208)", () => {
  it("maps each Core lifecycle callback onto the compositor", async () => {
    const { controller, updates } = makeController();
    const options = controller.buildReplyOptions();

    await options.onToolStart?.({ name: "read", args: { path: "docs.md" } });
    await options.onItemEvent?.({
      kind: "preamble",
      progressText: "Checking the docs",
      itemId: "pre-1",
    });
    await options.onPlanUpdate?.({
      phase: "update",
      explanation: "Look it up",
      steps: [{ step: "Read docs", status: "in_progress" }],
    });
    await options.onApprovalEvent?.({
      phase: "requested",
      title: "approval requested",
      command: "rm -rf /tmp/x",
    });
    await options.onCommandOutput?.({
      phase: "end",
      name: "exec",
      title: "ls",
      exitCode: 0,
    });
    await options.onPatchSummary?.({
      phase: "end",
      name: "apply_patch",
      added: ["src/a.ts"],
    });
    await options.onNarrationUpdate?.({ text: "Looking through the files" });

    const snapshot = controller.getSnapshot();
    expect(snapshot.lines.length).toBeGreaterThan(0);
    expect(snapshot.plan).toEqual([{ step: "Read docs", status: "in_progress" }]);
    expect(snapshot.statusHeadline).toBeTruthy();
    expect(updates.length).toBeGreaterThan(0);
  });

  it("does not force a visible draft for a fast turn before the Core start gate", async () => {
    vi.useFakeTimers();
    const { controller, updates } = makeController();
    await controller.buildReplyOptions().onToolStart?.({ name: "read" });
    expect(updates).toEqual([]);
    expect(controller.hasStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_400);
    expect(updates).toEqual([]);
    expect(controller.hasStarted).toBe(false);
  });

  it("suppresses default standalone tool-progress messages only while the draft owns them", () => {
    expect(
      makeController({ mode: "progress" }).controller.buildReplyOptions()
        .suppressDefaultToolProgressMessages,
    ).toBe(true);
    expect(
      makeController({ mode: "partial" }).controller.buildReplyOptions()
        .suppressDefaultToolProgressMessages,
    ).toBe(false);
    expect(
      makeController({ mode: "off" }).controller.buildReplyOptions()
        .suppressDefaultToolProgressMessages,
    ).toBe(false);
    expect(
      makeController({ mode: "progress", active: false }).controller.buildReplyOptions()
        .suppressDefaultToolProgressMessages,
    ).toBe(false);
  });

  it("preserves async callback start order", async () => {
    const order: string[] = [];
    const { controller } = makeController();
    const options = controller.buildReplyOptions();
    expect(options.preserveProgressCallbackStartOrder).toBe(true);

    const first = options.onToolStart?.({ name: "first" });
    const second = options.onToolStart?.({ name: "second" });
    await Promise.all([
      Promise.resolve(first).then(() => order.push("first")),
      Promise.resolve(second).then(() => order.push("second")),
    ]);
    expect(order).toEqual(["first", "second"]);
  });

  it("does not let partial answer text clobber progress state", async () => {
    const { controller, updates } = makeController();
    const options = controller.buildReplyOptions();
    await options.onToolStart?.({ name: "read", args: { path: "docs.md" } });
    await controller.start();
    const before = controller.getSnapshot();
    await options.onPartialReply?.({ text: "this must not replace the draft" });
    expect(controller.getSnapshot()).toEqual(before);
    expect(updates.every((u) => !u.text.includes("this must not replace the draft"))).toBe(
      true,
    );
  });

  it("ignores late progress after final start/delivery", async () => {
    const { controller, updates } = makeController();
    const options = controller.buildReplyOptions();
    await options.onToolStart?.({ name: "read" });
    await controller.start();
    const beforeCount = updates.length;
    controller.markFinalReplyStarted();
    await options.onToolStart?.({ name: "web_search" });
    expect(updates.length).toBe(beforeCount);
    controller.markFinalReplyDelivered();
    await options.onItemEvent?.({ kind: "tool", name: "exec", title: "late" });
    expect(updates.length).toBe(beforeCount);
  });

  it("cancels timers, narrator lifecycle, and stale turn state on error", async () => {
    vi.useFakeTimers();
    const { controller, updates } = makeController();
    const options = controller.buildReplyOptions();
    const stopTurn = vi.fn();
    options.onProgressNarratorLifecycle?.({ beginTurn: vi.fn(), stopTurn });
    await options.onToolStart?.({ name: "read" });
    await options.onQueuedFollowupSettled?.();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stopTurn).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
    expect(controller.getSnapshot().lines).toEqual([]);
  });

  it("begins a fresh compositor and narrator turn for an admitted queued followup", async () => {
    const { controller } = makeController();
    const options = controller.buildReplyOptions();
    const beginTurn = vi.fn();
    const stopTurn = vi.fn();
    options.onProgressNarratorLifecycle?.({ beginTurn, stopTurn });
    await options.onToolStart?.({ name: "read" });
    controller.markFinalReplyStarted();
    controller.markFinalReplyDelivered();
    expect(stopTurn).toHaveBeenCalledTimes(1);
    await options.onQueuedFollowupAdmitted?.();
    expect(beginTurn).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().lines).toEqual([]);
    await options.onToolStart?.({ name: "web_search" });
    expect(controller.getSnapshot().lines.length).toBeGreaterThan(0);
  });

  it("wires onPartialReply only for partial preview mode", () => {
    expect(
      typeof makeController({ mode: "partial" }).controller.buildReplyOptions()
        .onPartialReply,
    ).toBe("function");
    expect(makeController({ mode: "block" }).controller.buildReplyOptions().onPartialReply)
      .toBeUndefined();
    expect(
      makeController({ mode: "progress" }).controller.buildReplyOptions()
        .onPartialReply,
    ).toBeUndefined();
    expect(makeController({ mode: "off" }).controller.buildReplyOptions().onPartialReply)
      .toBeUndefined();
  });

  it("does not forward reasoning unless the existing OpenClaw setting allows it", async () => {
    const hidden = makeController({ reasoningVisible: false });
    await hidden.controller.buildReplyOptions().onReasoningStream?.({
      text: "secret chain of thought",
    });
    expect(JSON.stringify(hidden.controller.getSnapshot())).not.toContain(
      "secret chain of thought",
    );

    const visible = makeController({ reasoningVisible: true });
    await visible.controller.buildReplyOptions().onReasoningStream?.({
      text: "visible reasoning",
    });
    await visible.controller.start();
    expect(JSON.stringify(visible.controller.getSnapshot())).toContain("visible reasoning");
  });

  it("yields progress to verbose standalone messages when Core reports them active", async () => {
    const { controller, updates } = makeController();
    const options = controller.buildReplyOptions();
    options.onVerboseProgressVisibility?.(() => true);
    await options.onToolStart?.({ name: "read" });
    await controller.start();
    expect(updates).toEqual([]);
  });

  it("suppresses duplicate progress through Core line identity", async () => {
    const { controller, updates } = makeController();
    const options = controller.buildReplyOptions();
    await options.onToolStart?.({ name: "read", toolCallId: "call-1" });
    await controller.start();
    const afterFirst = updates.length;
    await options.onToolStart?.({ name: "read", toolCallId: "call-1" });
    expect(updates.length).toBe(afterFirst);
  });

  it("can show tool progress in progress mode even when no onPartialReply text arrives", async () => {
    const { controller, updates } = makeController();
    const options = controller.buildReplyOptions();
    expect(options.onPartialReply).toBeUndefined();
    await options.onToolStart?.({ name: "read", args: { path: "README.md" } });
    await controller.start();
    expect(updates.some((u) => /read/i.test(u.text))).toBe(true);
  });
});
