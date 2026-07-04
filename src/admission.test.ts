import { describe, it, expect } from "vitest";
import {
  isCliqSenderAllowed,
  resolveCliqDmAdmission,
  resolveCliqDmPolicy,
  type CliqDmPolicy,
} from "./admission.js";
import type { ParsedCliqInbound } from "./inbound.js";
import type { ResolvedCliqAccount } from "./client.js";

function account(overrides: Partial<ResolvedCliqAccount> = {}): ResolvedCliqAccount {
  return {
    accountId: null,
    clientId: "id",
    clientSecret: "secret",
    botId: "bot",
    botName: "Bot",
    webhookSecret: undefined,
    allowFrom: [],
    dmPolicy: undefined,
    ...overrides,
  };
}

function dmParsed(overrides: Partial<ParsedCliqInbound> = {}): ParsedCliqInbound {
  return {
    text: "hi",
    messageId: "m1",
    timestamp: "",
    senderId: "u1",
    senderName: "Alice",
    chatId: "CT_dm-B1",
    isGroup: false,
    isMention: false,
    mentionIds: [],
    handler: "message",
    ...overrides,
  };
}

function groupParsed(overrides: Partial<ParsedCliqInbound> = {}): ParsedCliqInbound {
  return {
    text: "hi @bot",
    messageId: "m2",
    timestamp: "",
    senderId: "u2",
    senderName: "Bob",
    chatId: "CT_channel",
    channelUniqueName: "dev-team",
    channelName: "dev-team",
    isGroup: true,
    isMention: true,
    mentionIds: ["bot"],
    handler: "mention",
    ...overrides,
  };
}

describe("resolveCliqDmPolicy", () => {
  it("returns the configured policy when valid", () => {
    expect(resolveCliqDmPolicy(account({ dmPolicy: "open" }))).toBe("open");
    expect(resolveCliqDmPolicy(account({ dmPolicy: "allowlist" }))).toBe("allowlist");
    expect(resolveCliqDmPolicy(account({ dmPolicy: "pairing" }))).toBe("pairing");
    expect(resolveCliqDmPolicy(account({ dmPolicy: "disabled" }))).toBe("disabled");
  });

  it("normalizes whitespace and case", () => {
    expect(resolveCliqDmPolicy(account({ dmPolicy: "  Open " }))).toBe("open");
    expect(resolveCliqDmPolicy(account({ dmPolicy: "ALLOWLIST" }))).toBe("allowlist");
  });

  it("falls back to allowlist when unset", () => {
    expect(resolveCliqDmPolicy(account({ dmPolicy: undefined }))).toBe("allowlist");
  });

  it("falls back to allowlist for unknown values (deny-by-default)", () => {
    expect(resolveCliqDmPolicy(account({ dmPolicy: "nonsense" }))).toBe("allowlist");
    expect(resolveCliqDmPolicy(account({ dmPolicy: "" }))).toBe("allowlist");
  });
});

describe("isCliqSenderAllowed", () => {
  it("returns false for empty allowlist", () => {
    expect(isCliqSenderAllowed("u1", [])).toBe(false);
    expect(isCliqSenderAllowed("u1", undefined)).toBe(false);
  });

  it("returns true when wildcard present", () => {
    expect(isCliqSenderAllowed("u1", ["*"])).toBe(true);
    expect(isCliqSenderAllowed("u1", ["*", "u2"])).toBe(true);
  });

  it("matches a concrete sender id", () => {
    expect(isCliqSenderAllowed("u1", ["u1"])).toBe(true);
    expect(isCliqSenderAllowed("u1", ["u2"])).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isCliqSenderAllowed("Alice", ["alice"])).toBe(true);
    expect(isCliqSenderAllowed("ALICE", ["Alice"])).toBe(true);
  });

  it("accepts numeric entries coerced to strings", () => {
    expect(isCliqSenderAllowed("123", [123])).toBe(true);
    expect(isCliqSenderAllowed("123", [456])).toBe(false);
  });

  it("returns false for undefined sender id", () => {
    expect(isCliqSenderAllowed(undefined, ["u1"])).toBe(false);
  });
});

describe("resolveCliqDmAdmission", () => {
  it("always allows groups regardless of policy", () => {
    for (const policy of ["open", "allowlist", "pairing", "disabled"] as CliqDmPolicy[]) {
      const adm = resolveCliqDmAdmission(
        groupParsed(),
        account({ dmPolicy: policy, allowFrom: [] }),
      );
      expect(adm.decision).toBe("allow");
      expect(adm.reason).toBe("group_message");
    }
  });

  it("allows DMs under open policy even with empty allowlist", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed(),
      account({ dmPolicy: "open", allowFrom: [] }),
    );
    expect(adm.decision).toBe("allow");
    expect(adm.senderAllowed).toBe(true);
    expect(adm.reason).toBe("dm_policy_open");
  });

  it("denies all DMs under disabled policy", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u1" }),
      account({ dmPolicy: "disabled", allowFrom: ["u1", "*"] }),
    );
    expect(adm.decision).toBe("deny");
    expect(adm.senderAllowed).toBe(false);
    expect(adm.reason).toBe("dm_policy_disabled");
  });

  it("allows DM under allowlist when sender matches", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u1" }),
      account({ dmPolicy: "allowlist", allowFrom: ["u1"] }),
    );
    expect(adm.decision).toBe("allow");
    expect(adm.senderAllowed).toBe(true);
    expect(adm.reason).toBe("allowlist_match");
  });

  it("denies DM under allowlist when sender does not match", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u2" }),
      account({ dmPolicy: "allowlist", allowFrom: ["u1"] }),
    );
    expect(adm.decision).toBe("deny");
    expect(adm.senderAllowed).toBe(false);
    expect(adm.reason).toBe("not_in_allowlist");
  });

  it("denies DM under allowlist with empty allowFrom (deny-by-default)", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u1" }),
      account({ dmPolicy: "allowlist", allowFrom: [] }),
    );
    expect(adm.decision).toBe("deny");
    expect(adm.reason).toBe("not_in_allowlist");
  });

  it("allows DM under allowlist with wildcard", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u3" }),
      account({ dmPolicy: "allowlist", allowFrom: ["*"] }),
    );
    expect(adm.decision).toBe("allow");
    expect(adm.senderAllowed).toBe(true);
  });

  it("allows DM under pairing when sender already in allowFrom", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u1" }),
      account({ dmPolicy: "pairing", allowFrom: ["u1"] }),
    );
    expect(adm.decision).toBe("allow");
    expect(adm.reason).toBe("allowlist_match");
  });

  it("emits pairing decision under pairing when sender not in allowFrom", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u_new" }),
      account({ dmPolicy: "pairing", allowFrom: ["u1"] }),
    );
    expect(adm.decision).toBe("pairing");
    expect(adm.senderAllowed).toBe(false);
    expect(adm.reason).toBe("needs_pairing");
  });

  it("emits pairing decision under pairing with empty allowFrom", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u_new" }),
      account({ dmPolicy: "pairing", allowFrom: [] }),
    );
    expect(adm.decision).toBe("pairing");
  });

  it("defaults to allowlist policy when dmPolicy unset", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u2" }),
      account({ dmPolicy: undefined, allowFrom: ["u1"] }),
    );
    expect(adm.policy).toBe("allowlist");
    expect(adm.decision).toBe("deny");
  });

  it("treats unknown dmPolicy as allowlist", () => {
    const adm = resolveCliqDmAdmission(
      dmParsed({ senderId: "u1" }),
      account({ dmPolicy: "garbage" as unknown as string, allowFrom: ["u1"] }),
    );
    expect(adm.policy).toBe("allowlist");
    expect(adm.decision).toBe("allow");
  });
});
