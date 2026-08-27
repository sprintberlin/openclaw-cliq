import { describe, it, expect, vi } from "vitest";
import {
  inspectCliqBot,
  resolveCliqSubscriptionState,
  toCliqDoctorBotInspection,
  describeCliqBotInspection,
  type CliqBotReader,
  type CliqBotRecord,
  type CliqBotSubscriberPage,
  type CliqBotReadFailure,
} from "./bot-inspect.js";

const WEBHOOK_SECRET = "webhook-secret-value";

function account(overrides: Record<string, unknown> = {}) {
  return {
    botId: "openclaw-bot",
    botName: "OpenClaw",
    webhookSecret: WEBHOOK_SECRET,
    ...overrides,
  } as Parameters<typeof inspectCliqBot>[0]["account"];
}

function botRecord(overrides: Partial<CliqBotRecord> = {}): CliqBotRecord {
  return {
    id: "b-2500338000009392001",
    unique_name: "openclaw-bot",
    name: "OpenClaw",
    status: "enabled",
    scope: "organization",
    execution_type: "deluge",
    channel_participation: ["listen_message", "send_message"],
    handlers: [{ type: "message_handler" }, { type: "mention_handler" }],
    subscriber_count: 3,
    ...overrides,
  };
}

function handlerScript(secret: string, url = "https://cliq.example.com/cliq/webhook"): string {
  return [
    'webhookUrl = "' + url + '";',
    'webhookSecret = "' + secret + '";',
    "response = invokeurl[url: webhookUrl type: POST];",
  ].join("\n");
}

function reader(overrides: Partial<CliqBotReader> = {}): CliqBotReader {
  return {
    listBots: vi.fn(async () => [botRecord()]),
    getBot: vi.fn(async () => botRecord()),
    listSubscribers: vi.fn(
      async (): Promise<CliqBotSubscriberPage> => ({
        subscribers: [{ user_id: "user-1", name: "Ada", email_id: "ada@example.com" }],
        complete: true,
      }),
    ),
    readHandlerScript: vi.fn(async () => ({ script: handlerScript(WEBHOOK_SECRET) })),
    ...overrides,
  };
}

const MISSING_SCOPE: CliqBotReadFailure = {
  kind: "missing_scope",
  detail: "Zoho refused the read with HTTP 403",
};

describe("inspectCliqBot — organization-visible, active, subscribed", () => {
  it("reads active state, visibility, and subscription from the documented bot fields", async () => {
    const result = await inspectCliqBot({
      account: account(),
      publicWebhookUrl: "https://cliq.example.com/cliq/webhook",
      reader: reader(),
    });
    expect(result.exists).toEqual({ state: "known", value: true });
    expect(result.active).toEqual({ state: "known", value: "active" });
    expect(result.visibility).toEqual({ state: "known", value: "organization" });
    expect(result.botId).toMatchObject({ state: "known", value: "b-2500338000009392001" });
    expect(result.subscriberCount).toEqual({ state: "known", value: 3 });
    expect(resolveCliqSubscriptionState(result, "user-1")).toEqual({
      state: "known",
      value: "subscribed",
    });
    expect(toCliqDoctorBotInspection(result).status).toBe("pass");
  });

  it("resolves the internal bot id from the configured unique name before reading the bot", async () => {
    const dependencies = reader();
    await inspectCliqBot({ account: account(), reader: dependencies });
    expect(dependencies.getBot).toHaveBeenCalledWith("b-2500338000009392001");
  });
});

describe("inspectCliqBot — organization-visible, not subscribed", () => {
  it("reports not_subscribed only when the subscriber walk completed", async () => {
    const result = await inspectCliqBot({
      account: account(),
      reader: reader({
        listSubscribers: vi.fn(async () => ({
          subscribers: [{ user_id: "user-1", name: "Ada" }],
          complete: true,
        })),
      }),
    });
    expect(result.visibility).toEqual({ state: "known", value: "organization" });
    expect(resolveCliqSubscriptionState(result, "user-999")).toEqual({
      state: "known",
      value: "not_subscribed",
    });
  });

  it("never claims not_subscribed from a truncated subscriber walk", async () => {
    const result = await inspectCliqBot({
      account: account(),
      reader: reader({
        listSubscribers: vi.fn(async () => ({
          subscribers: [{ user_id: "user-1", name: "Ada" }],
          complete: false,
        })),
      }),
    });
    const state = resolveCliqSubscriptionState(result, "user-999");
    expect(state.state).toBe("unknown");
    expect(state.state === "unknown" ? state.reason : "").toMatch(/page|truncat|complete/i);
    // A user that WAS seen is still honestly subscribed.
    expect(resolveCliqSubscriptionState(result, "user-1")).toEqual({
      state: "known",
      value: "subscribed",
    });
  });
});

describe("inspectCliqBot — unknown subscription state", () => {
  it("keeps bot state known while subscription is unknown when Zoho refuses the subscriber list", async () => {
    const result = await inspectCliqBot({
      account: account(),
      reader: reader({
        listSubscribers: vi.fn(async () => ({
          kind: "forbidden" as const,
          detail: "Zoho answered HTTP 403",
        })),
      }),
    });
    expect(result.exists.state).toBe("known");
    expect(result.active.state).toBe("known");
    expect(result.visibility.state).toBe("known");
    expect(result.subscribers.state).toBe("unknown");
    const state = resolveCliqSubscriptionState(result, "user-1");
    expect(state.state).toBe("unknown");
    const rendered = describeCliqBotInspection(result).join(" ");
    expect(rendered).toMatch(/unknown/i);
    expect(rendered).not.toMatch(/not.?subscribed/i);
    expect(toCliqDoctorBotInspection(result).status).toBe("warn");
  });

  it("reports an unrecognised status word as unknown rather than guessing inactive", async () => {
    const result = await inspectCliqBot({
      account: account(),
      reader: reader({ getBot: vi.fn(async () => botRecord({ status: "something_new" })) }),
    });
    expect(result.active.state).toBe("unknown");
    expect(toCliqDoctorBotInspection(result).status).toBe("warn");
  });
});

describe("inspectCliqBot — wrong scope", () => {
  it("reports every bot fact as unknown without claiming the bot is missing", async () => {
    const result = await inspectCliqBot({
      account: account(),
      reader: reader({
        listBots: vi.fn(async () => MISSING_SCOPE),
        getBot: vi.fn(async () => MISSING_SCOPE),
        listSubscribers: vi.fn(async () => MISSING_SCOPE),
        readHandlerScript: vi.fn(async () => ({
          error: "could not mint a ZohoCliq.Bots.READ access token",
        })),
      }),
    });
    expect(result.exists.state).toBe("unknown");
    expect(result.active.state).toBe("unknown");
    expect(result.visibility.state).toBe("unknown");
    expect(result.subscribers.state).toBe("unknown");
    const doctor = toCliqDoctorBotInspection(result);
    expect(doctor.status).toBe("warn");
    expect(doctor.evidence.join(" ")).toContain("ZohoCliq.Bots.READ");
    expect(doctor.evidence.join(" ")).not.toMatch(/bot does not exist|bot is missing/i);
  });

  it("distinguishes a missing scope from the subscriber-list permission refusal", async () => {
    const refused = await inspectCliqBot({
      account: account(),
      reader: reader({
        listSubscribers: vi.fn(async () => ({ kind: "forbidden" as const, detail: "HTTP 403" })),
      }),
    });
    expect(refused.visibility.state).toBe("known");
    expect(refused.subscribers.state).toBe("unknown");

    const unscoped = await inspectCliqBot({
      account: account(),
      reader: reader({
        listBots: vi.fn(async () => MISSING_SCOPE),
        getBot: vi.fn(async () => MISSING_SCOPE),
        listSubscribers: vi.fn(async () => MISSING_SCOPE),
      }),
    });
    expect(unscoped.visibility.state).toBe("unknown");
    expect(unscoped.subscribers.state).toBe("unknown");
  });

  it("reports a narrower bot scope as known, not unknown", async () => {
    const result = await inspectCliqBot({
      account: account(),
      reader: reader({
        getBot: vi.fn(async () => botRecord({ scope: "team", team_ids: ["t-1"] })),
      }),
    });
    expect(result.visibility).toEqual({ state: "known", value: "team" });
    const doctor = toCliqDoctorBotInspection(result);
    expect(doctor.status).toBe("warn");
    expect(doctor.evidence.join(" ")).toMatch(/team/);
  });
});

describe("inspectCliqBot — absent bot and handler conflicts", () => {
  it("reports a bot that is genuinely absent from the readable listing as a failure", async () => {
    const result = await inspectCliqBot({
      account: account(),
      reader: reader({
        listBots: vi.fn(async () => [botRecord({ unique_name: "someone-else" })]),
        getBot: vi.fn(async () => ({ kind: "not_found" as const, detail: "bot_not_found" })),
      }),
    });
    expect(result.exists).toEqual({ state: "known", value: false });
    expect(toCliqDoctorBotInspection(result).status).toBe("fail");
  });

  it("fails when the handler URL matches but the Zoho-held secret differs", async () => {
    const result = await inspectCliqBot({
      account: account(),
      publicWebhookUrl: "https://cliq.example.com/cliq/webhook",
      reader: reader({
        readHandlerScript: vi.fn(async () => ({ script: handlerScript("a-different-secret") })),
      }),
    });
    expect(result.handlerConsistency.status).toBe("fail");
    const doctor = toCliqDoctorBotInspection(result);
    expect(doctor.status).toBe("fail");
    expect(JSON.stringify(doctor)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(doctor)).not.toContain("a-different-secret");
  });
});

describe("inspectCliqBot — disclosure", () => {
  it("never carries a handler script, a subscriber email, or a raw response body", async () => {
    const result = await inspectCliqBot({
      account: account(),
      publicWebhookUrl: "https://cliq.example.com/cliq/webhook",
      reader: reader({
        readHandlerScript: vi.fn(async () => ({
          script: handlerScript(WEBHOOK_SECRET) + '\nsentinel = "SCRIPT_SENTINEL";',
        })),
        listSubscribers: vi.fn(async () => ({
          subscribers: [{ user_id: "user-1", name: "Ada", email_id: "sentinel@example.com" }],
          complete: true,
        })),
      }),
    });
    const serialized = JSON.stringify([result, toCliqDoctorBotInspection(result), describeCliqBotInspection(result)]);
    expect(serialized).not.toContain("SCRIPT_SENTINEL");
    expect(serialized).not.toContain("sentinel@example.com");
    expect(serialized).not.toContain(WEBHOOK_SECRET);
  });
});
