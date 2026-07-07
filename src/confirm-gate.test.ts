import { describe, it, expect } from "vitest";
import {
  CLIQ_CONFIRM_SENTINEL,
  CLIQ_CANCEL_SENTINEL,
  CLIQ_CONFIRM_MAX_TEXT_LEN,
  DEFAULT_CLIQ_CONFIRM_KEYWORDS,
  parseCliqConfirmAction,
  isConfirmGateArmed,
  isSensitiveInbound,
  buildConfirmCardButtons,
} from "./confirm-gate.js";
import { parseCliqWebhookPayload } from "./inbound.js";
import type { ResolvedCliqAccount } from "./client.js";

function account(opts: Partial<ResolvedCliqAccount> = {}): ResolvedCliqAccount {
  return {
    accountId: null,
    clientId: "id",
    clientSecret: "secret",
    botId: "bot",
    botName: "Bot",
    allowFrom: [],
    dmPolicy: undefined,
    ackPolicy: "after_dispatch",
    selfSenderIds: [],
    blockStreaming: false,
    thinking: { mode: "off", text: "💭 …" },
    welcome: { enabled: false, text: "", textRejoin: "" },
    pairing: { notifyOwnerTarget: null, approveLabel: "Approve", denyLabel: "Deny", approvalTitle: "🔐 Pairing request", approvedOwnerText: "✅ Approved.", deniedOwnerText: "🚫 Denied." },
    ...opts,
  };
}

function dmPayload(text: string): ReturnType<typeof dmPayloadRaw> {
  return dmPayloadRaw(text);
}
function dmPayloadRaw(text: string) {
  return parseCliqWebhookPayload({
    handler: "message",
    message: text,
    user: { id: "u1", name: "Alice" },
    chat: { id: "CT_dm" },
  })!;
}

describe("parseCliqConfirmAction", () => {
  it("detects a confirm sentinel + original text", () => {
    const r = parseCliqConfirmAction(`${CLIQ_CONFIRM_SENTINEL} drop the table`);
    expect(r.action).toBe("confirm");
    expect(r.text).toBe("drop the table");
  });

  it("detects a cancel sentinel", () => {
    const r = parseCliqConfirmAction(CLIQ_CANCEL_SENTINEL);
    expect(r.action).toBe("cancel");
    expect(r.text).toBe("");
  });

  it("cancel sentinel ignores trailing text", () => {
    const r = parseCliqConfirmAction(`${CLIQ_CANCEL_SENTINEL} drop the table`);
    expect(r.action).toBe("cancel");
    expect(r.text).toBe("");
  });

  it("returns undefined action for a normal message", () => {
    const r = parseCliqConfirmAction("please drop the table");
    expect(r.action).toBeUndefined();
    expect(r.text).toBe("please drop the table");
  });

  it("treats a bare confirm sentinel as a confirm of empty text", () => {
    const r = parseCliqConfirmAction(CLIQ_CONFIRM_SENTINEL);
    expect(r.action).toBe("confirm");
    expect(r.text).toBe("");
  });

  it("does not false-positive on a message that merely contains the sentinel substring", () => {
    const r = parseCliqConfirmAction(`foo ${CLIQ_CONFIRM_SENTINEL} bar`);
    expect(r.action).toBeUndefined();
    expect(r.text).toBe(`foo ${CLIQ_CONFIRM_SENTINEL} bar`);
  });
});

describe("isConfirmGateArmed", () => {
  it("is armed when card mode + confirm sensitive", () => {
    expect(
      isConfirmGateArmed(
        account({ thinking: { mode: "card", text: "x", confirm: "sensitive" } }),
      ),
    ).toBe(true);
  });

  it("is armed when card mode + confirm always", () => {
    expect(
      isConfirmGateArmed(
        account({ thinking: { mode: "card", text: "x", confirm: "always" } }),
      ),
    ).toBe(true);
  });

  it("is not armed when confirm is off", () => {
    expect(
      isConfirmGateArmed(
        account({ thinking: { mode: "card", text: "x", confirm: "off" } }),
      ),
    ).toBe(false);
  });

  it("is not armed when confirm is unset (undefined)", () => {
    expect(
      isConfirmGateArmed(account({ thinking: { mode: "card", text: "x" } })),
    ).toBe(false);
  });

  it("is not armed when mode is not card (even with confirm set)", () => {
    expect(
      isConfirmGateArmed(
        account({ thinking: { mode: "placeholder", text: "x", confirm: "always" } }),
      ),
    ).toBe(false);
  });
});

describe("isSensitiveInbound", () => {
  const armed = (overrides: Partial<ResolvedCliqAccount["thinking"]> = {}) =>
    account({
      thinking: {
        mode: "card",
        text: "Generating…",
        confirm: "sensitive",
        ...overrides,
      },
      refreshToken: "rt",
      blockStreaming: false,
    });

  it("matches a destructive keyword (delete)", () => {
    expect(isSensitiveInbound(dmPayload("please delete the users table"), armed())).toBe(true);
  });

  it("matches a multi-word keyword (drop table)", () => {
    expect(isSensitiveInbound(dmPayload("please drop table users"), armed())).toBe(true);
  });

  it("does not match a benign message", () => {
    expect(isSensitiveInbound(dmPayload("what is the weather"), armed())).toBe(false);
  });

  it("does not false-match on substrings (reset vs reseat)", () => {
    expect(isSensitiveInbound(dmPayload("please reseat the guests"), armed())).toBe(false);
  });

  it("does not match inflected forms (deleted does not match delete — word boundary)", () => {
    expect(isSensitiveInbound(dmPayload("I deleted the row"), armed())).toBe(false);
  });

  it("matches when followed by punctuation (delete!)", () => {
    expect(isSensitiveInbound(dmPayload("delete!"), armed())).toBe(true);
  });

  it("gates every turn when confirm is always", () => {
    const always = armed({ confirm: "always" });
    expect(isSensitiveInbound(dmPayload("hello there"), always)).toBe(true);
  });

  it("is never sensitive when confirm is off", () => {
    const off = armed({ confirm: "off" });
    expect(isSensitiveInbound(dmPayload("delete everything"), off)).toBe(false);
  });

  it("respects a custom confirmKeywords list", () => {
    const custom = armed({ confirmKeywords: ["selfdestruct"] });
    expect(isSensitiveInbound(dmPayload("selfdestruct now"), custom)).toBe(true);
    expect(isSensitiveInbound(dmPayload("delete everything"), custom)).toBe(false);
  });

  it("is never sensitive when keywords is empty (sensitive mode)", () => {
    const empty = armed({ confirm: "sensitive", confirmKeywords: [] });
    expect(isSensitiveInbound(dmPayload("delete everything"), empty)).toBe(false);
  });

  it("bypasses the gate when the text exceeds the encode cap", () => {
    const long = "x".repeat(CLIQ_CONFIRM_MAX_TEXT_LEN + 1);
    expect(isSensitiveInbound(dmPayload(`delete ${long}`), armed())).toBe(false);
  });

  it("is never sensitive for a confirm re-dispatch (loop prevention)", () => {
    const confirmed = parseCliqWebhookPayload({
      handler: "message",
      message: `${CLIQ_CONFIRM_SENTINEL} delete the table`,
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm" },
    })!;
    expect(confirmed.confirmAction).toBe("confirm");
    expect(isSensitiveInbound(confirmed, armed())).toBe(false);
  });

  it("the default keyword list is non-empty and includes delete", () => {
    expect(DEFAULT_CLIQ_CONFIRM_KEYWORDS.length).toBeGreaterThan(0);
    expect(DEFAULT_CLIQ_CONFIRM_KEYWORDS).toContain("delete");
  });
});

describe("buildConfirmCardButtons", () => {
  it("builds a confirm + cancel button pair encoding the original text", () => {
    const out = buildConfirmCardButtons({
      botId: "bot",
      originalText: "drop the table",
    });
    expect(out).not.toBeNull();
    expect(out!.confirm.action).toBe("invoke");
    expect(out!.confirm.data).toBe(`${CLIQ_CONFIRM_SENTINEL} drop the table`);
    expect(out!.cancel.action).toBe("invoke");
    expect(out!.cancel.data).toBe(CLIQ_CANCEL_SENTINEL);
  });

  it("returns null when no botId is configured", () => {
    expect(
      buildConfirmCardButtons({ botId: undefined, originalText: "delete x" }),
    ).toBeNull();
  });

  it("returns null when the original text exceeds the encode cap", () => {
    expect(
      buildConfirmCardButtons({
        botId: "bot",
        originalText: "x".repeat(CLIQ_CONFIRM_MAX_TEXT_LEN + 1),
      }),
    ).toBeNull();
  });

  it("honors custom button labels, falling back to defaults on empty", () => {
    const out = buildConfirmCardButtons({
      botId: "bot",
      originalText: "delete x",
      confirmLabel: "  ",
      cancelLabel: "",
    });
    expect(out!.confirm.label).toBe("Confirm");
    expect(out!.cancel.label).toBe("Cancel");
  });
});
