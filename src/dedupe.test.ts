import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildCliqDedupeKey,
  beginCliqContentTurn,
  claimCliqMessage,
  commitCliqMessage,
  releaseCliqMessage,
  resetCliqDedupeForTest,
  type CliqContentTurn,
} from "./dedupe.js";
import { parseCliqWebhookPayload, type ParsedCliqInbound } from "./inbound.js";

function parsed(overrides: Partial<ParsedCliqInbound> = {}): ParsedCliqInbound {
  return {
    text: "hello",
    messageId: "m1",
    timestamp: "2024-01-01T00:00:00Z",
    senderId: "u1",
    senderName: "Alice",
    chatId: "CT_dm_chat-B1",
    isGroup: false,
    isMention: false,
    mentionIds: [],
    attachments: [],
    handler: "message",
    ...overrides,
  };
}

const account = { accountId: "default" as string | null };
const accountAcct = { accountId: "acct-1" };

describe("buildCliqDedupeKey", () => {
  it("prefers messageId with namespace prefix", () => {
    expect(buildCliqDedupeKey(parsed(), account)).toBe("cliq:default:mid:m1");
  });

  it("scopes by accountId when present", () => {
    expect(buildCliqDedupeKey(parsed(), accountAcct)).toBe("cliq:acct-1:mid:m1");
  });

  it("falls back to sender:chat:text composite when messageId absent", () => {
    const p = parsed({ messageId: "" });
    expect(buildCliqDedupeKey(p, account)).toBe(
      "cliq:default:cmp:u1:CT_dm_chat-B1:hello",
    );
  });

  it("returns null when nothing stable to key on", () => {
    expect(buildCliqDedupeKey(parsed({ messageId: "", senderId: "" }), account)).toBeNull();
    expect(buildCliqDedupeKey(parsed({ messageId: "", chatId: "" }), account)).toBeNull();
    expect(buildCliqDedupeKey(parsed({ messageId: "", text: "" }), account)).toBeNull();
  });
});

describe("claimCliqMessage / commit / release", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  it("claims a fresh message id", async () => {
    const claim = await claimCliqMessage(parsed(), account);
    expect(claim).not.toBeNull();
    expect(claim!.kind).toBe("claimed");
    expect(claim!.key).toBe("cliq:default:mid:m1");
  });

  it("reports a duplicate after commit", async () => {
    const claim1 = await claimCliqMessage(parsed(), account);
    expect(claim1!.kind).toBe("claimed");
    await commitCliqMessage(claim1!.key);

    const claim2 = await claimCliqMessage(parsed(), account);
    expect(claim2!.kind).toBe("duplicate");
  });

  it("allows re-claim after release (retryable failure)", async () => {
    const claim1 = await claimCliqMessage(parsed(), account);
    expect(claim1!.kind).toBe("claimed");
    releaseCliqMessage(claim1!.key, new Error("boom"));

    const claim2 = await claimCliqMessage(parsed(), account);
    expect(claim2!.kind).toBe("claimed");
  });

  it("reports inflight for a concurrent claim of the same id", async () => {
    const claim1 = await claimCliqMessage(parsed(), account);
    expect(claim1!.kind).toBe("claimed");
    // Without committing/releasing, a second claim of the same key is inflight.
    const claim2 = await claimCliqMessage(parsed(), account);
    expect(claim2!.kind).toBe("inflight");
  });

  it("dedupes across distinct message ids independently", async () => {
    const a = await claimCliqMessage(parsed({ messageId: "a" }), account);
    const b = await claimCliqMessage(parsed({ messageId: "b" }), account);
    expect(a!.kind).toBe("claimed");
    expect(b!.kind).toBe("claimed");
    await commitCliqMessage(a!.key);
    await commitCliqMessage(b!.key);
    const a2 = await claimCliqMessage(parsed({ messageId: "a" }), account);
    expect(a2!.kind).toBe("duplicate");
  });

  it("scopes dedupe by account namespace", async () => {
    const c1 = await claimCliqMessage(parsed(), { accountId: "acct-a" });
    const c2 = await claimCliqMessage(parsed(), { accountId: "acct-b" });
    expect(c1!.kind).toBe("claimed");
    expect(c2!.kind).toBe("claimed");
    await commitCliqMessage(c1!.key);
    // Same message id under a different account is NOT a duplicate.
    const c1bis = await claimCliqMessage(parsed(), { accountId: "acct-a" });
    expect(c1bis!.kind).toBe("duplicate");
  });

  it("returns null (no dedupe) when no stable key", async () => {
    const p = parsed({ messageId: "", senderId: "", chatId: "" });
    const claim = await claimCliqMessage(p, account);
    expect(claim).toBeNull();
    // commit/release on null key are no-ops.
    await commitCliqMessage(null);
    releaseCliqMessage(null);
  });

  it("falls back to composite key dedupe when messageId absent", async () => {
    const p = parsed({ messageId: "" });
    const c1 = await claimCliqMessage(p, account);
    expect(c1!.kind).toBe("claimed");
    expect(c1!.key).toBe("cliq:default:cmp:u1:CT_dm_chat-B1:hello");
    await commitCliqMessage(c1!.key);
    const c2 = await claimCliqMessage(p, account);
    expect(c2!.kind).toBe("duplicate");
  });

  it("keys a caption-less file message by sender:chat:file:<names> (issue #84)", () => {
    const p = parsed({
      messageId: "",
      text: "",
      attachments: [{ fileName: "2020_03.png" }],
    });
    expect(buildCliqDedupeKey(p, account)).toBe(
      "cliq:default:cmp:u1:CT_dm_chat-B1:file:2020_03.png",
    );
  });

  it("keys a caption-less file message with multiple names by joined names", () => {
    const p = parsed({
      messageId: "",
      text: "",
      attachments: [{ fileName: "a.png" }, { fileName: "b.png" }],
    });
    expect(buildCliqDedupeKey(p, account)).toBe(
      "cliq:default:cmp:u1:CT_dm_chat-B1:file:a.png,b.png",
    );
  });

  it("dedupes a redelivered caption-less file message (issue #84)", async () => {
    const p = parsed({
      messageId: "",
      text: "",
      attachments: [{ fileName: "2020_03.png" }],
    });
    const c1 = await claimCliqMessage(p, account);
    expect(c1!.kind).toBe("claimed");
    expect(c1!.key).toBe("cliq:default:cmp:u1:CT_dm_chat-B1:file:2020_03.png");
    await commitCliqMessage(c1!.key);
    // Cliq redelivers the same upload ~20s later → deduped.
    const c2 = await claimCliqMessage(p, account);
    expect(c2!.kind).toBe("duplicate");
  });

  it("returns null for a caption-less file with no attachment names", () => {
    const p = parsed({ messageId: "", text: "", attachments: [{ fileName: "" }] });
    expect(buildCliqDedupeKey(p, account)).toBeNull();
  });

  it("uses the synthetic id (syn:...) as the dedupe key when parseCliqWebhookPayload generated one (issue #88)", async () => {
    // After issue #88, parseCliqWebhookPayload generates a synthetic
    // messageId for empty-id attachment messages. The dedupe layer uses
    // that synthetic id directly as the key (the `mid:` path).
    const syntheticId = "syn:a1b2c3d4e5f60718";
    const p = parsed({
      messageId: syntheticId,
      text: "<file: photo.png>",
      attachments: [{ fileName: "photo.png" }],
    });
    const c1 = await claimCliqMessage(p, account);
    expect(c1).not.toBeNull();
    expect(c1!.kind).toBe("claimed");
    expect(c1!.key).toBe(`cliq:default:mid:${syntheticId}`);
    await commitCliqMessage(c1!.key);
    // Redelivery with the same synthetic id → deduped (no self-conflict).
    const c2 = await claimCliqMessage(p, account);
    expect(c2!.kind).toBe("duplicate");
  });

  it("a synthetic-id message is deduped independently from a real-id message", async () => {
    const synthetic = parsed({ messageId: "syn:abc123" });
    const real = parsed({ messageId: "real-msg-id" });
    const c1 = await claimCliqMessage(synthetic, account);
    const c2 = await claimCliqMessage(real, account);
    expect(c1!.kind).toBe("claimed");
    expect(c2!.kind).toBe("claimed");
    expect(c1!.key).not.toBe(c2!.key);
  });
});

describe("dedupe TTL by key kind (issue #114)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCliqDedupeForTest();
  });

  const REDELIVERY_WINDOW_MS = 20_000;
  const PAST_CONTENT_TTL_MS = 5 * 60 * 1000;

  it("re-claims an identical slash command sent again well after the redelivery window (synthetic id)", async () => {
    const payload = {
      handler: "message",
      message: "/status",
      user: { id: "fake-user", name: "Test User" },
      chat: { id: "fake-chat", type: "dm" },
    };
    const command = parseCliqWebhookPayload(payload);
    expect(command).not.toBeNull();
    expect(command!.messageId).toMatch(/^syn:/);

    const sameCommandAgain = parseCliqWebhookPayload(payload);
    expect(sameCommandAgain).not.toBeNull();
    expect(sameCommandAgain!.messageId).toBe(command!.messageId);

    const first = await claimCliqMessage(command!, account);
    expect(first!.kind).toBe("claimed");
    await commitCliqMessage(first!.key);

    vi.advanceTimersByTime(REDELIVERY_WINDOW_MS);
    const redelivery = await claimCliqMessage(sameCommandAgain!, account);
    expect(redelivery!.kind).toBe("duplicate");

    vi.advanceTimersByTime(PAST_CONTENT_TTL_MS);
    const resend = await claimCliqMessage(sameCommandAgain!, account);
    expect(resend!.kind).toBe("claimed");
  });

  it("re-claims an identical slash command sent again well after the redelivery window (composite key)", async () => {
    const command = parsed({ messageId: "", text: "/new" });

    const first = await claimCliqMessage(command, account);
    expect(first!.kind).toBe("claimed");
    expect(first!.key).toBe("cliq:default:cmp:u1:CT_dm_chat-B1:/new");
    await commitCliqMessage(first!.key);

    vi.advanceTimersByTime(REDELIVERY_WINDOW_MS);
    const redelivery = await claimCliqMessage(command, account);
    expect(redelivery!.kind).toBe("duplicate");

    vi.advanceTimersByTime(PAST_CONTENT_TTL_MS);
    const resend = await claimCliqMessage(command, account);
    expect(resend!.kind).toBe("claimed");
  });

  it("keeps deduping a redelivered caption-less file message inside the redelivery window (issue #84)", async () => {
    const upload = parsed({
      messageId: "",
      text: "",
      attachments: [{ fileName: "quarterly.png" }],
    });

    const first = await claimCliqMessage(upload, account);
    expect(first!.kind).toBe("claimed");
    await commitCliqMessage(first!.key);

    vi.advanceTimersByTime(REDELIVERY_WINDOW_MS);
    const redelivery = await claimCliqMessage(upload, account);
    expect(redelivery!.kind).toBe("duplicate");
  });

  it("keeps the long TTL for a real message id, which is unique per message", async () => {
    const real = parsed({ messageId: "real-msg-1" });

    const first = await claimCliqMessage(real, account);
    expect(first!.kind).toBe("claimed");
    await commitCliqMessage(first!.key);

    vi.advanceTimersByTime(PAST_CONTENT_TTL_MS);
    const redelivery = await claimCliqMessage(real, account);
    expect(redelivery!.kind).toBe("duplicate");
  });

  it("keeps the long TTL for the synthetic welcome id so a subscriber is never greeted twice", async () => {
    const welcome = parsed({ messageId: "welcome:u1", text: "", attachments: [] });

    const first = await claimCliqMessage(welcome, account);
    expect(first!.kind).toBe("claimed");
    await commitCliqMessage(first!.key);

    vi.advanceTimersByTime(PAST_CONTENT_TTL_MS);
    const redelivery = await claimCliqMessage(welcome, account);
    expect(redelivery!.kind).toBe("duplicate");
  });
});

describe("beginCliqContentTurn (issue #123)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  function contentMessage(text = "explain this"): ParsedCliqInbound {
    const message = parseCliqWebhookPayload({
      handler: "message",
      message: text,
      user: { id: "u-1", name: "Alice" },
      chat: { id: "CT_dm", type: "dm" },
    });
    expect(message).not.toBeNull();
    expect(message!.messageId).toMatch(/^syn:/);
    return message!;
  }

  it("reports no equivalent turn in flight for the first content-derived delivery", () => {
    const turn = beginCliqContentTurn(contentMessage(), account);
    expect(turn).not.toBeNull();
    expect(turn!.hadInFlightTurn).toBe(false);
    turn!.finish();
  });

  it("reports an equivalent turn in flight for a redelivery of the same content", () => {
    const first = beginCliqContentTurn(contentMessage(), account);
    expect(first!.hadInFlightTurn).toBe(false);

    const redelivery = beginCliqContentTurn(contentMessage(), account);
    expect(redelivery!.hadInFlightTurn).toBe(true);

    redelivery!.finish();
    first!.finish();
  });

  it("clears the in-flight marker once the original turn finishes", () => {
    const first = beginCliqContentTurn(contentMessage(), account);
    first!.finish();

    const later = beginCliqContentTurn(contentMessage(), account);
    expect(later!.hadInFlightTurn).toBe(false);
    later!.finish();
  });

  it("keeps distinct senders, chats and texts independent", () => {
    const alice = beginCliqContentTurn(contentMessage("same words"), account);
    expect(alice!.hadInFlightTurn).toBe(false);

    const otherText = beginCliqContentTurn(contentMessage("different words"), account);
    expect(otherText!.hadInFlightTurn).toBe(false);

    const otherAccount = beginCliqContentTurn(contentMessage("same words"), {
      accountId: "acct-b",
    });
    expect(otherAccount!.hadInFlightTurn).toBe(false);

    otherAccount!.finish();
    otherText!.finish();
    alice!.finish();
  });

  it("does not track a real Cliq message id (not content-derived)", () => {
    const turn: CliqContentTurn | null = beginCliqContentTurn(
      parsed({ messageId: "real-1" }),
      account,
    );
    expect(turn).toBeNull();
  });

  it("does not track a Deluge eventId as content-derived (issue #196)", () => {
    const turn: CliqContentTurn | null = beginCliqContentTurn(
      parsed({ messageId: "evt:abc123", text: "/new" }),
      account,
    );
    expect(turn).toBeNull();
  });
});

describe("Deluge eventId handoff (issue #196)", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCliqDedupeForTest();
  });

  it("lets two identical commands through when each has its own eventId", async () => {
    const first = parseCliqWebhookPayload({
      handler: "message",
      message: "/new",
      eventId: "delivery-1",
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm" },
    });
    const second = parseCliqWebhookPayload({
      handler: "message",
      message: "/new",
      eventId: "delivery-2",
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm" },
    });
    expect(first!.messageId).toBe("evt:delivery-1");
    expect(second!.messageId).toBe("evt:delivery-2");

    const c1 = await claimCliqMessage(first!, account);
    expect(c1!.kind).toBe("claimed");
    await commitCliqMessage(c1!.key);
    const c2 = await claimCliqMessage(second!, account);
    expect(c2!.kind).toBe("claimed");
  });

  it("dedupes an exact webhook replay of the same eventId past the content TTL", async () => {
    const payload = {
      handler: "message",
      message: "/new",
      eventId: "same-delivery",
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm" },
    };
    const first = parseCliqWebhookPayload(payload);
    const replay = parseCliqWebhookPayload(payload);
    expect(first!.messageId).toBe(replay!.messageId);

    const c1 = await claimCliqMessage(first!, account);
    expect(c1!.kind).toBe("claimed");
    await commitCliqMessage(c1!.key);

    vi.advanceTimersByTime(5 * 60 * 1000);
    const c2 = await claimCliqMessage(replay!, account);
    expect(c2!.kind).toBe("duplicate");
    expect(c2!.key).toBe("cliq:default:mid:evt:same-delivery");
  });
});
