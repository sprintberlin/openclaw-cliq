import { describe, it, expect, vi } from "vitest";
import {
  startThinkingAnimation,
  resolveThinkingFrames,
} from "./thinking-animate.js";
import {
  DEFAULT_CLIQ_THINKING_ANIMATE_INTERVAL_MS,
  MAX_CLIQ_THINKING_ANIMATE_DURATION_MS,
  MIN_CLIQ_THINKING_ANIMATE_INTERVAL_MS,
} from "./client.js";
import type { CliqClient } from "./client.js";

interface FakeClient {
  edits: { chatId: string; messageId: string; text: string }[];
  chatIdResolves: { name: string; chatId: string | undefined }[];
  editMessage: (opts: {
    chatId: string;
    messageId: string;
    text: string;
  }) => Promise<{ messageId?: string; chatId?: string }>;
  resolveChannelChatId: (name: string) => Promise<string | undefined>;
}

function makeFakeClient(opts: {
  editFails?: boolean;
  channelChatId?: string | undefined;
} = {}): FakeClient & Pick<CliqClient, "editMessage" | "resolveChannelChatId"> {
  const edits: { chatId: string; messageId: string; text: string }[] = [];
  const chatIdResolves: { name: string; chatId: string | undefined }[] = [];
  return {
    edits,
    chatIdResolves,
    editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => {
      edits.push(o);
      if (opts.editFails) throw new Error("edit rejected");
      return { messageId: o.messageId, chatId: o.chatId };
    }),
    resolveChannelChatId: vi.fn(async (name: string) => {
      const result = opts.channelChatId ?? undefined;
      chatIdResolves.push({ name, chatId: result });
      return result;
    }),
  };
}

/** A deterministic scheduler that advances on demand (no real timers). */
function makeFakeScheduler() {
  const queue: { id: number; fn: (() => void) | null; at: number }[] = [];
  let now = 0;
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: vi.fn((fn: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ id, fn, at: now + ms });
      return id;
    }),
    clearTimeout: vi.fn((handle: unknown) => {
      const id = handle as number;
      const job = queue.find((q) => q.id === id);
      if (job) job.fn = null; // mark cancelled; will be skipped when due
    }),
    /** Advance virtual time by `ms`, firing any due callbacks in order. */
    advance: (ms: number) => {
      const target = now + ms;
      // Process due jobs in scheduled order. New jobs added during a tick are
      // only fired if they fall at/below the target (recursive setTimeout).
      while (queue.length > 0) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const job = queue[0];
        if (job.at > target) break;
        queue.shift();
        now = job.at;
        if (job.fn) job.fn();
      }
      now = target;
    },
    pending: () => queue.filter((q) => q.fn !== null).length,
    setNow: (t: number) => { now = t; },
  };
}

describe("resolveThinkingFrames (issue #86)", () => {
  it("returns null for mode 'off'", () => {
    expect(resolveThinkingFrames("off")).toBeNull();
  });

  it("returns the dots frames for 'dots'", () => {
    expect(resolveThinkingFrames("dots")).toEqual(["💭 .", "💭 ..", "💭 ..."]);
  });

  it("returns spinner frames prefixed with a fixed label for 'spinner'", () => {
    const frames = resolveThinkingFrames("spinner")!;
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((f) => f.endsWith("thinking…"))).toBe(true);
  });

  it("returns custom frames when ≥2 non-empty strings are provided", () => {
    expect(resolveThinkingFrames("custom", ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns null for 'custom' with fewer than 2 usable frames (nothing to cycle)", () => {
    expect(resolveThinkingFrames("custom", ["a"])).toBeNull();
    expect(resolveThinkingFrames("custom", [])).toBeNull();
    expect(resolveThinkingFrames("custom", ["", "  "])).toBeNull();
    expect(resolveThinkingFrames("custom")).toBeNull();
  });
});

describe("startThinkingAnimation (issue #86)", () => {
  it("returns null for mode 'off' (no animation)", () => {
    const fake = makeFakeClient();
    const anim = startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "off",
    });
    expect(anim).toBeNull();
  });

  it("returns null when frames collapse to a single frame (nothing to cycle)", () => {
    const fake = makeFakeClient();
    const anim = startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "custom",
      frames: ["only"],
    });
    expect(anim).toBeNull();
  });

  it("floors the interval to MIN_CLIQ_THINKING_ANIMATE_INTERVAL_MS", () => {
    const fake = makeFakeClient();
    const sched = makeFakeScheduler();
    startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "dots",
      intervalMs: 50, // below the 800 ms floor
      scheduler: sched,
    });
    // The first setTimeout should be scheduled at the floored interval.
    expect(sched.setTimeout).toHaveBeenCalledWith(expect.any(Function), MIN_CLIQ_THINKING_ANIMATE_INTERVAL_MS);
  });

  it("uses the default interval when intervalMs is unset", () => {
    const fake = makeFakeClient();
    const sched = makeFakeScheduler();
    startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "dots",
      scheduler: sched,
    });
    expect(sched.setTimeout).toHaveBeenCalledWith(expect.any(Function), DEFAULT_CLIQ_THINKING_ANIMATE_INTERVAL_MS);
  });

  it("advances one frame per interval via editMessage (DM with known chatId)", async () => {
    const fake = makeFakeClient();
    const sched = makeFakeScheduler();
    const frames = ["💭 .", "💭 ..", "💭 ..."];
    const anim = startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "custom",
      frames,
      intervalMs: 1000,
      scheduler: sched,
    });
    expect(anim).not.toBeNull();
    expect(fake.edits).toHaveLength(0); // no edit before the first tick
    sched.advance(1000);
    await vi.waitFor(() => expect(fake.edits).toHaveLength(1));
    expect(fake.edits[0].text).toBe(frames[1]); // frame 0 is the placeholder itself; first advance → frame 1
    sched.advance(1000);
    await vi.waitFor(() => expect(fake.edits).toHaveLength(2));
    expect(fake.edits[1].text).toBe(frames[2]);
    sched.advance(1000);
    await vi.waitFor(() => expect(fake.edits).toHaveLength(3));
    expect(fake.edits[2].text).toBe(frames[0]); // wraps around
  });

  it("stop() cancels the timer — no further frame edits (reply arrives)", async () => {
    const fake = makeFakeClient();
    const sched = makeFakeScheduler();
    const anim = startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "dots",
      intervalMs: 1000,
      scheduler: sched,
    })!;
    sched.advance(1000);
    await vi.waitFor(() => expect(fake.edits).toHaveLength(1));
    anim.stop();
    sched.advance(1000);
    sched.advance(1000);
    expect(fake.edits).toHaveLength(1); // stopped — no more edits
    expect(sched.pending()).toBe(0);
  });

  it("stop() is idempotent", () => {
    const fake = makeFakeClient();
    const sched = makeFakeScheduler();
    const anim = startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "dots",
      scheduler: sched,
    })!;
    anim.stop();
    anim.stop(); // should not throw
    expect(sched.pending()).toBe(0);
  });

  it("a failed frame edit stops the animation and reports via onError (never breaks the turn)", async () => {
    const fake = makeFakeClient({ editFails: true });
    const sched = makeFakeScheduler();
    const errors: { kind: string }[] = [];
    const anim = startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "dots",
      intervalMs: 1000,
      onError: (_err, info) => errors.push(info),
      scheduler: sched,
    })!;
    sched.advance(1000);
    // The failed edit is async — let it settle.
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toEqual({ kind: "thinking-animate-frame" });
    expect(sched.pending()).toBe(0); // animation stopped
    anim.stop(); // idempotent — no throw
  });

  it("stops advancing after the max-duration cap (holds the last frame)", async () => {
    const fake = makeFakeClient();
    const sched = makeFakeScheduler();
    const cap = 2500;
    startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "dots",
      intervalMs: 1000,
      maxDurationMs: cap,
      scheduler: sched,
    });
    sched.advance(1000); // t=1000 → frame 1
    await vi.waitFor(() => expect(fake.edits).toHaveLength(1));
    sched.advance(1000); // t=2000 → frame 2
    await vi.waitFor(() => expect(fake.edits).toHaveLength(2));
    sched.advance(1000); // t=3000 > cap(2500) → stop, no edit
    expect(fake.edits).toHaveLength(2);
    expect(sched.pending()).toBe(0);
  });

  it("resolves the chat id lazily for a group post before the first edit", async () => {
    const fake = makeFakeClient({ channelChatId: "CT_dev_team" });
    const sched = makeFakeScheduler();
    startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1" }, // no chatId — group post
      to: "dev-team",
      isDm: false,
      mode: "dots",
      intervalMs: 1000,
      scheduler: sched,
    });
    sched.advance(1000);
    await vi.waitFor(() => expect(fake.edits).toHaveLength(1));
    expect(fake.chatIdResolves).toHaveLength(1);
    expect(fake.chatIdResolves[0]).toEqual({ name: "dev-team", chatId: "CT_dev_team" });
    expect(fake.edits[0].chatId).toBe("CT_dev_team");
  });

  it("stops animating when the group chat id cannot be resolved (no edit, no throw)", async () => {
    const fake = makeFakeClient({ channelChatId: undefined });
    const sched = makeFakeScheduler();
    startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1" },
      to: "dev-team",
      isDm: false,
      mode: "dots",
      intervalMs: 1000,
      scheduler: sched,
    });
    sched.advance(1000);
    await Promise.resolve(); // flush the resolveChannelChatId microtask
    expect(fake.edits).toHaveLength(0);
    expect(sched.pending()).toBe(0); // stopped
  });

  it("uses the max-duration cap default when maxDurationMs is unset", async () => {
    const fake = makeFakeClient();
    const sched = makeFakeScheduler();
    startThinkingAnimation({
      client: fake,
      draft: { messageId: "m1", chatId: "chat-1" },
      to: "u1",
      isDm: true,
      mode: "dots",
      intervalMs: 1000,
      scheduler: sched,
    });
    // Advance just past the cap — animation should stop.
    sched.advance(MAX_CLIQ_THINKING_ANIMATE_DURATION_MS + 1000);
    // The exact count depends on the cap/interval ratio; the key invariant is
    // that the animation stopped (no pending timer) and edits are bounded.
    await vi.waitFor(() => expect(sched.pending()).toBe(0));
    expect(fake.edits.length).toBeLessThanOrEqual(
      Math.ceil(MAX_CLIQ_THINKING_ANIMATE_DURATION_MS / 1000),
    );
  });
});
