import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedCliqAccount } from "./client.js";
import {
  DEFAULT_CLIQ_WELCOME_REJOIN_TEXT,
  DEFAULT_CLIQ_WELCOME_TEXT,
} from "./client.js";
import {
  isCliqWelcomePayload,
  parseCliqWelcomePayload,
  renderCliqWelcomeText,
  resolveCliqWelcomeGreeting,
  buildCliqWelcomeInbound,
  handleCliqWelcome,
} from "./welcome.js";
import { resetCliqDedupeForTest } from "./dedupe.js";

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
    ackPolicy: "after_dispatch",
    selfSenderIds: [],
    blockStreaming: false,
    thinking: { mode: "off", text: "💭 …" },
    welcome: { enabled: false, text: "", textRejoin: "" },
    pairing: { notifyOwnerTarget: null, approveLabel: "Approve", denyLabel: "Deny", approvalTitle: "🔐 Pairing request", approvedOwnerText: "✅ Approved.", deniedOwnerText: "🚫 Denied." },
    ...overrides,
  };
}

describe("isCliqWelcomePayload", () => {
  it("recognizes handler === 'welcome'", () => {
    expect(isCliqWelcomePayload({ handler: "welcome" })).toBe(true);
  });

  it("recognizes handler === 'subscribe'", () => {
    expect(isCliqWelcomePayload({ handler: "subscribe" })).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(isCliqWelcomePayload({ handler: "  Welcome " })).toBe(true);
  });

  it("rejects message / mention handlers", () => {
    expect(isCliqWelcomePayload({ handler: "message" })).toBe(false);
    expect(isCliqWelcomePayload({ handler: "mention" })).toBe(false);
  });

  it("rejects non-object / empty payloads", () => {
    expect(isCliqWelcomePayload(null)).toBe(false);
    expect(isCliqWelcomePayload(undefined)).toBe(false);
    expect(isCliqWelcomePayload("welcome")).toBe(false);
    expect(isCliqWelcomePayload([])).toBe(false);
    expect(isCliqWelcomePayload({})).toBe(false);
  });
});

describe("parseCliqWelcomePayload", () => {
  it("extracts user + newUser flag (new subscriber)", () => {
    const parsed = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", first_name: "Jane", last_name: "Doe", email_id: "jane@x.com" },
      newuser: true,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.senderId).toBe("u1");
    expect(parsed!.senderName).toBe("Jane Doe");
    expect(parsed!.senderEmail).toBe("jane@x.com");
    expect(parsed!.newUser).toBe(true);
    expect(parsed!.handler).toBe("welcome");
  });

  it("treats a returning subscriber (newuser:false) as a re-subscribe", () => {
    const parsed = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u2", name: "Bob" },
      newuser: false,
    });
    expect(parsed!.newUser).toBe(false);
    expect(parsed!.senderName).toBe("Bob");
  });

  it("defaults newUser to true when the flag is absent (conservative)", () => {
    const parsed = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u3", name: "Carl" },
    });
    expect(parsed!.newUser).toBe(true);
  });

  it("unwraps a `params` wrapper", () => {
    const parsed = parseCliqWelcomePayload({
      handler: "welcome",
      params: { user: { id: "u4", name: "Dan" }, newuser: false },
    });
    expect(parsed!.senderId).toBe("u4");
    expect(parsed!.newUser).toBe(false);
  });

  it("falls back to the id when no name fields are present", () => {
    const parsed = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u5" },
    });
    expect(parsed!.senderName).toBe("u5");
  });

  it("returns null when the payload carries no subscriber id", () => {
    expect(parseCliqWelcomePayload({ handler: "welcome", user: { name: "NoId" } })).toBeNull();
    expect(parseCliqWelcomePayload({ handler: "welcome" })).toBeNull();
  });

  it("prefers email_id over email", () => {
    const parsed = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u6", email_id: "primary@x.com", email: "secondary@x.com" },
    });
    expect(parsed!.senderEmail).toBe("primary@x.com");
  });
});

describe("renderCliqWelcomeText", () => {
  const user = {
    id: "u1",
    first_name: "Jane",
    last_name: "Doe",
    email_id: "jane@x.com",
  };

  it("substitutes firstName / lastName / name / id / email", () => {
    expect(
      renderCliqWelcomeText(
        "Hi {{firstName}} {{lastName}} ({{id}}) — {{email}}",
        user,
      ),
    ).toBe("Hi Jane Doe (u1) — jane@x.com");
    expect(renderCliqWelcomeText("{{name}}", user)).toBe("Jane Doe");
  });

  it("accepts snake_case placeholders", () => {
    expect(renderCliqWelcomeText("{{first_name}} {{last_name}}", user)).toBe(
      "Jane Doe",
    );
  });

  it("derives firstName from the first token of name when first_name is absent", () => {
    expect(
      renderCliqWelcomeText("Hi {{firstName}}", { id: "x", name: "Ada Lovelace" }),
    ).toBe("Hi Ada");
  });

  it("leaves unknown placeholders verbatim", () => {
    expect(renderCliqWelcomeText("Hi {{unknownVar}}", user)).toBe(
      "Hi {{unknownVar}}",
    );
  });

  it("is case-insensitive on placeholder keys", () => {
    expect(renderCliqWelcomeText("{{FIRSTNAME}}", user)).toBe("Jane");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderCliqWelcomeText("{{  firstName  }}", user)).toBe("Jane");
  });

  it("returns the template verbatim when no placeholders are present", () => {
    expect(renderCliqWelcomeText("plain text no placeholders", user)).toBe(
      "plain text no placeholders",
    );
  });
});

describe("buildCliqWelcomeInbound", () => {
  it("produces a DM-shaped ParsedCliqInbound with a synthetic welcome messageId", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", name: "Jane" },
    })!;
    const inbound = buildCliqWelcomeInbound(welcome);
    expect(inbound.isGroup).toBe(false);
    expect(inbound.senderId).toBe("u1");
    expect(inbound.messageId).toBe("welcome:u1");
    expect(inbound.attachments).toEqual([]);
    expect(inbound.text).toBe("");
  });
});

describe("resolveCliqWelcomeGreeting", () => {
  it("returns null when welcome is disabled", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", name: "Jane" },
    })!;
    expect(
      resolveCliqWelcomeGreeting(welcome, account({ welcome: { enabled: false, text: "x", textRejoin: "y" } })),
    ).toBeNull();
  });

  it("returns the new-subscriber text for a first-time subscriber", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", first_name: "Jane" },
      newuser: true,
    })!;
    const greeting = resolveCliqWelcomeGreeting(
      welcome,
      account({
        welcome: { enabled: true, text: "Hello {{firstName}}!", textRejoin: "Welcome back {{firstName}}!" },
        dmPolicy: "open",
      }),
    );
    expect(greeting).toBe("Hello Jane!");
  });

  it("returns the rejoin text for a returning subscriber", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", first_name: "Jane" },
      newuser: false,
    })!;
    const greeting = resolveCliqWelcomeGreeting(
      welcome,
      account({
        welcome: { enabled: true, text: "Hello {{firstName}}!", textRejoin: "Welcome back {{firstName}}!" },
        dmPolicy: "open",
      }),
    );
    expect(greeting).toBe("Welcome back Jane!");
  });

  it("uses the default greeting when no custom text is configured", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", first_name: "Jane" },
      newuser: true,
    })!;
    const greeting = resolveCliqWelcomeGreeting(
      welcome,
      account({
        welcome: { enabled: true, text: DEFAULT_CLIQ_WELCOME_TEXT, textRejoin: DEFAULT_CLIQ_WELCOME_REJOIN_TEXT },
        dmPolicy: "open",
      }),
    );
    expect(greeting).toContain("👋 Hi Jane!");
  });

  it("denies a sender not in the allowlist under allowlist policy", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "stranger", name: "Stranger" },
      newuser: true,
    })!;
    expect(
      resolveCliqWelcomeGreeting(
        welcome,
        account({
          welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
          dmPolicy: "allowlist",
          allowFrom: ["someone-else"],
        }),
      ),
    ).toBeNull();
  });

  it("greets a sender in the allowlist under allowlist policy", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", first_name: "Jane" },
      newuser: true,
    })!;
    expect(
      resolveCliqWelcomeGreeting(
        welcome,
        account({
          welcome: { enabled: true, text: "Hi {{firstName}}", textRejoin: "Hi" },
          dmPolicy: "allowlist",
          allowFrom: ["u1"],
        }),
      ),
    ).toBe("Hi Jane");
  });

  it("greets any sender under open policy", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "anyone", name: "Anyone" },
      newuser: true,
    })!;
    expect(
      resolveCliqWelcomeGreeting(
        welcome,
        account({
          welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
          dmPolicy: "open",
        }),
      ),
    ).toBe("Hi");
  });

  it("never greets under disabled policy", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", name: "Jane" },
      newuser: true,
    })!;
    expect(
      resolveCliqWelcomeGreeting(
        welcome,
        account({
          welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
          dmPolicy: "disabled",
        }),
      ),
    ).toBeNull();
  });

  it("does not greet an un-paired subscriber under pairing policy", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "stranger", name: "Stranger" },
      newuser: true,
    })!;
    expect(
      resolveCliqWelcomeGreeting(
        welcome,
        account({
          welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
          dmPolicy: "pairing",
          allowFrom: [],
        }),
      ),
    ).toBeNull();
  });

  it("greets an already-paired subscriber under pairing policy", () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", first_name: "Jane" },
      newuser: true,
    })!;
    expect(
      resolveCliqWelcomeGreeting(
        welcome,
        account({
          welcome: { enabled: true, text: "Hi {{firstName}}", textRejoin: "Hi" },
          dmPolicy: "pairing",
          allowFrom: ["u1"],
        }),
      ),
    ).toBe("Hi Jane");
  });
});

describe("handleCliqWelcome", () => {
  beforeEach(() => {
    resetCliqDedupeForTest();
  });

  it("sends the greeting DM to the subscriber via the bot-message endpoint", async () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", first_name: "Jane" },
      newuser: true,
    })!;
    const client = {
      sendMessage: vi.fn(async () => ({ messageId: "greet-1", chatId: "ct-1" })),
    };
    const ref = await handleCliqWelcome({
      welcome,
      account: account({
        welcome: { enabled: true, text: "Hi {{firstName}}", textRejoin: "Hi" },
        dmPolicy: "open",
      }),
      client,
    });
    expect(ref).toEqual({ messageId: "greet-1", chatId: "ct-1" });
    expect(client.sendMessage).toHaveBeenCalledWith({
      to: "u1",
      text: "Hi Jane",
      isDm: true,
    });
  });

  it("returns null (no send) when welcome is disabled", async () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", name: "Jane" },
    })!;
    const client = { sendMessage: vi.fn(async () => ({ messageId: "x" })) };
    const ref = await handleCliqWelcome({
      welcome,
      account: account({ welcome: { enabled: false, text: "", textRejoin: "" } }),
      client,
    });
    expect(ref).toBeNull();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("returns null (no send) when the sender is denied", async () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "stranger", name: "Stranger" },
    })!;
    const client = { sendMessage: vi.fn(async () => ({ messageId: "x" })) };
    const ref = await handleCliqWelcome({
      welcome,
      account: account({
        welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
        dmPolicy: "allowlist",
        allowFrom: ["someone-else"],
      }),
      client,
    });
    expect(ref).toBeNull();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("swallows a send failure (never throws) and reports via onError", async () => {
    const welcome = parseCliqWelcomePayload({
      handler: "welcome",
      user: { id: "u1", name: "Jane" },
    })!;
    const client = {
      sendMessage: vi.fn(async () => {
        throw new Error("zoho 500");
      }),
    };
    const errors: { kind: string; err: unknown }[] = [];
    const ref = await handleCliqWelcome({
      welcome,
      account: account({
        welcome: { enabled: true, text: "Hi", textRejoin: "Hi" },
        dmPolicy: "open",
      }),
      client,
      onError: (err, info) => errors.push({ kind: info.kind, err }),
    });
    expect(ref).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("welcome-greeting");
  });
});
