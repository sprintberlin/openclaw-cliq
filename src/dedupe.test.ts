import { describe, it, expect, beforeEach } from "vitest";
import {
  buildCliqDedupeKey,
  claimCliqMessage,
  commitCliqMessage,
  releaseCliqMessage,
  resetCliqDedupeForTest,
} from "./dedupe.js";
import type { ParsedCliqInbound } from "./inbound.js";

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
});
