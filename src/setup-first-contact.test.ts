import { describe, it, expect, vi } from "vitest";
import {
  redactCliqIdentifier,
  sendCliqFirstContactDm,
} from "./setup-first-contact.js";

const WEBHOOK_SECRET = "webhook-secret-value";

function target(overrides: Record<string, unknown> = {}) {
  return { id: "user-1", label: "Ada Ops", resolved: true, ...overrides } as Parameters<
    typeof sendCliqFirstContactDm
  >[0]["target"];
}

function confirmingPrompter(answer: boolean) {
  const confirm = vi.fn(async () => answer);
  return {
    confirm,
    prompter: {
      confirm,
      note: vi.fn(async () => {}),
    } as unknown as Parameters<typeof sendCliqFirstContactDm>[0]["prompter"],
  };
}

describe("redactCliqIdentifier", () => {
  it("keeps a short recognisable prefix and hides the rest", () => {
    const redacted = redactCliqIdentifier("CT_abcdef123456");
    expect(redacted).not.toContain("abcdef123456");
    expect(redacted).toContain("CT_");
  });

  it("reports a missing identifier as unknown instead of inventing one", () => {
    expect(redactCliqIdentifier(undefined)).toBe("unknown");
    expect(redactCliqIdentifier("")).toBe("unknown");
  });
});

describe("sendCliqFirstContactDm — explicit consent", () => {
  it("sends exactly one clearly labeled DM to the resolved target after confirmation", async () => {
    const sendMessage = vi.fn(async () => ({ messageId: "MSG_abcdef123456", chatId: "CT_abcdef123456" }));
    const { prompter, confirm } = confirmingPrompter(true);
    const result = await sendCliqFirstContactDm({
      client: { sendMessage },
      target: target(),
      prompter,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as { to: string; isDm: boolean; text: string };
    expect(call.to).toBe("user-1");
    expect(call.isDm).toBe(true);
    expect(call.text).toContain("OpenClaw");
    expect(confirm).toHaveBeenCalledTimes(1);
    const confirmMessage = String(((confirm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { message?: string })?.message ?? "");
    expect(confirmMessage).toContain("Ada Ops");
    expect(result.sent).toBe(true);
  });

  it("asks for confirmation before sending anything", async () => {
    const order: string[] = [];
    const sendMessage = vi.fn(async () => {
      order.push("send");
      return { messageId: "MSG_1", chatId: "CT_1" };
    });
    const confirm = vi.fn(async () => {
      order.push("confirm");
      return true;
    });
    await sendCliqFirstContactDm({
      client: { sendMessage },
      target: target(),
      prompter: { confirm, note: vi.fn(async () => {}) } as never,
    });
    expect(order).toEqual(["confirm", "send"]);
  });

  it("requires a second confirmation before messaging an unresolved target", async () => {
    const sendMessage = vi.fn(async () => ({ messageId: "MSG_1", chatId: "CT_1" }));
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(false);
    const result = await sendCliqFirstContactDm({
      client: { sendMessage },
      target: target({ id: "nobody@example.com", label: undefined, resolved: false }),
      prompter: { confirm, note: vi.fn(async () => {}) } as never,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.sent).toBe(false);
    const asked = (confirm as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String((call[0] as { message?: string })?.message ?? ""))
      .join(" ");
    expect(asked).toMatch(/could not resolve|unresolved/i);
  });
});

describe("sendCliqFirstContactDm — cancellation", () => {
  it("sends nothing when the operator declines", async () => {
    const sendMessage = vi.fn(async () => ({ messageId: "MSG_1", chatId: "CT_1" }));
    const { prompter } = confirmingPrompter(false);
    const result = await sendCliqFirstContactDm({
      client: { sendMessage },
      target: target(),
      prompter,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: false, reason: "cancelled" });
  });

  it("degrades instead of throwing when Zoho rejects the send", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error(`cliq: send failed (400): {"webhookSecret":"${WEBHOOK_SECRET}"}`);
    });
    const { prompter } = confirmingPrompter(true);
    const result = await sendCliqFirstContactDm({
      client: { sendMessage },
      target: target(),
      prompter,
      sensitiveValues: [WEBHOOK_SECRET],
    });
    expect(result.sent).toBe(false);
    expect(JSON.stringify(result)).not.toContain(WEBHOOK_SECRET);
  });
});

describe("sendCliqFirstContactDm — redacted identifiers", () => {
  it("returns redacted chat and message identifiers, never the raw ids", async () => {
    const sendMessage = vi.fn(async () => ({ messageId: "MSG_abcdef123456", chatId: "CT_abcdef123456" }));
    const { prompter } = confirmingPrompter(true);
    const result = await sendCliqFirstContactDm({
      client: { sendMessage },
      target: target(),
      prompter,
    });
    expect(result.sent).toBe(true);
    expect(JSON.stringify(result)).not.toContain("abcdef123456");
    expect(result.sent ? result.chatId : "").toContain("CT_");
    expect(result.sent ? result.messageId : "").toContain("MSG_");
  });

  it("reports unknown identifiers when the send response carries none", async () => {
    const sendMessage = vi.fn(async () => ({}));
    const { prompter } = confirmingPrompter(true);
    const result = await sendCliqFirstContactDm({
      client: { sendMessage },
      target: target(),
      prompter,
    });
    expect(result.sent).toBe(true);
    expect(result.sent ? result.chatId : "").toBe("unknown");
    expect(result.sent ? result.messageId : "").toBe("unknown");
  });
});
