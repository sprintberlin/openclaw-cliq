import { describe, it, expect } from "vitest";
import type { ParsedCliqInbound } from "./inbound.js";
import type { ResolvedCliqAccount } from "./client.js";
import {
  isCliqSelfMessage,
  resolveCliqBotIdentities,
  resolveCliqOwnBotIdentities,
} from "./self-message.js";

function account(
  overrides: Partial<Pick<ResolvedCliqAccount, "botId" | "botName" | "ownSenderIds" | "selfSenderIds">> = {},
): Pick<ResolvedCliqAccount, "botId" | "botName" | "ownSenderIds" | "selfSenderIds"> {
  return {
    botId: "",
    botName: "",
    ownSenderIds: [],
    selfSenderIds: [],
    ...overrides,
  };
}

function parsed(
  overrides: Partial<
    Pick<ParsedCliqInbound, "senderId" | "senderName" | "senderEmail">
  > = {},
): Pick<ParsedCliqInbound, "senderId" | "senderName" | "senderEmail"> {
  return {
    senderId: "",
    senderName: "",
    senderEmail: undefined,
    ...overrides,
  };
}

describe("resolveCliqBotIdentities", () => {
  it("includes botId and botName lowercased + trimmed", () => {
    const ids = resolveCliqBotIdentities(
      account({ botId: "  Bot1 ", botName: "Zora" }),
    );
    expect(ids).toEqual(new Set(["bot1", "zora"]));
  });

  it("drops empty/whitespace-only entries", () => {
    const ids = resolveCliqBotIdentities(
      account({ botId: "bot", botName: "   " }),
    );
    expect(ids).toEqual(new Set(["bot"]));
  });

  it("merges selfSenderIds (trimmed, lowercased)", () => {
    const ids = resolveCliqBotIdentities(
      account({
        botId: "bot",
        botName: "Bot",
        selfSenderIds: ["  70000000001 ", "OtherBot"],
      }),
    );
    expect(ids).toEqual(new Set(["bot", "70000000001", "otherbot"]));
  });

  it("dedupes overlapping botId / botName / selfSenderIds", () => {
    const ids = resolveCliqBotIdentities(
      account({
        botId: "zora",
        botName: "ZORA",
        selfSenderIds: ["zora", "Zora"],
      }),
    );
    expect(ids).toEqual(new Set(["zora"]));
  });

  it("includes ownSenderIds in the full self/ignore set", () => {
    const ids = resolveCliqBotIdentities(
      account({
        botId: "zora",
        botName: "Zora",
        ownSenderIds: ["  b-ZORA "],
        selfSenderIds: ["b-paula"],
      }),
    );
    expect(ids).toEqual(new Set(["zora", "b-zora", "b-paula"]));
  });

  it("returns empty set when nothing is configured", () => {
    expect(resolveCliqBotIdentities(account({ botId: "", botName: "" }))).toEqual(
      new Set(),
    );
  });
});

describe("isCliqSelfMessage", () => {
  it("matches when senderId equals botId", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "bot", senderName: "Alice" }),
      account({ botId: "bot", botName: "Bot" }),
    );
    expect(m.self).toBe(true);
    expect(m.matchedField).toBe("senderId");
    expect(m.matchedValue).toBe("bot");
  });

  it("matches case-insensitively on botId", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "BOT" }),
      account({ botId: "bot" }),
    );
    expect(m.self).toBe(true);
    expect(m.matchedIdentity).toBe("bot");
  });

  it("trims whitespace before comparing", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "  bot  " }),
      account({ botId: "bot" }),
    );
    expect(m.self).toBe(true);
  });

  it("matches when senderName equals botName", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "u1", senderName: "Zora" }),
      account({ botId: "bot", botName: "Zora" }),
    );
    expect(m.self).toBe(true);
    expect(m.matchedField).toBe("senderName");
  });

  it("matches on senderEmail when it equals a configured identity", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "u1", senderName: "Alice", senderEmail: "bot@cliq" }),
      account({ botId: "bot@cliq", botName: "Bot" }),
    );
    expect(m.self).toBe(true);
    expect(m.matchedField).toBe("senderEmail");
  });

  it("matches a selfSenderIds entry (the bot's zuid)", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "70000000001", senderName: "OpenClaw Bot" }),
      account({
        botId: "openclaw-bot",
        botName: "OpenClaw Bot",
        selfSenderIds: ["70000000001"],
      }),
    );
    expect(m.self).toBe(true);
    expect(m.matchedField).toBe("senderId");
  });

  it("matches another Cliq bot listed in selfSenderIds", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "other-bot-zuid", senderName: "Other Bot" }),
      account({
        botId: "mybot",
        botName: "MyBot",
        selfSenderIds: ["other-bot-zuid"],
      }),
    );
    expect(m.self).toBe(true);
  });

  it("does not match a regular human sender", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "u123", senderName: "Alice", senderEmail: "alice@x" }),
      account({ botId: "bot", botName: "Bot" }),
    );
    expect(m.self).toBe(false);
  });

  it("returns not-self when no identities are configured", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "anyone", senderName: "Anyone" }),
      account({ botId: "", botName: "" }),
    );
    expect(m.self).toBe(false);
  });

  it("ignores undefined sender fields", () => {
    const m = isCliqSelfMessage(
      parsed({ senderId: "bot", senderName: undefined, senderEmail: undefined }),
      account({ botId: "bot" }),
    );
    expect(m.self).toBe(true);
    expect(m.matchedField).toBe("senderId");
  });
});

describe("resolveCliqOwnBotIdentities", () => {
  it("includes botId, botName, and ownSenderIds but not selfSenderIds", () => {
    const ids = resolveCliqOwnBotIdentities(
      account({
        botId: "zora",
        botName: "Zora",
        ownSenderIds: ["b-56320000003804003"],
        selfSenderIds: ["b-56320000003817004", "Paula"],
      }),
    );
    expect(ids).toEqual(new Set(["zora", "b-56320000003804003"]));
    expect(ids.has("paula")).toBe(false);
  });
});
