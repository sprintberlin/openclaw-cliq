import { describe, it, expect, vi } from "vitest";
import { runCliqSetupOnboarding } from "./setup-onboarding.js";
import { createCliqTestConfig as cfgWith } from "./test-api.js";
import type { CliqBotInspection } from "./bot-inspect.js";

function inspection(overrides: Partial<CliqBotInspection> = {}): CliqBotInspection {
  return {
    configuredUniqueName: "openclaw-bot",
    botId: { state: "known", value: "b-1" },
    exists: { state: "known", value: true },
    active: { state: "known", value: "active" },
    visibility: { state: "known", value: "organization" },
    teamIds: { state: "known", value: [] },
    channelParticipation: { state: "known", value: ["listen_message", "send_message"] },
    handlerTypes: { state: "known", value: ["message_handler", "mention_handler"] },
    executionType: { state: "known", value: "deluge" },
    subscriberCount: { state: "known", value: 1 },
    subscribers: { state: "known", value: { userIds: ["user-1"], complete: true } },
    handlerConsistency: { status: "pass", detail: "both handlers match" },
    ...overrides,
  };
}

function configured() {
  return cfgWith({
    clientId: "client-id",
    clientSecret: "client-secret",
    botId: "openclaw-bot",
    botName: "OpenClaw",
    webhookSecret: "webhook-secret",
    publicWebhookUrl: "https://cliq.example.com/cliq/webhook",
  });
}

function prompter(confirms: boolean[]) {
  const confirm = vi.fn(async () => confirms.shift() ?? false);
  const notes: string[] = [];
  return {
    confirm,
    notes,
    value: {
      confirm,
      text: vi.fn(async () => ""),
      note: vi.fn(async (message: string) => {
        notes.push(message);
      }),
    } as never,
  };
}

describe("runCliqSetupOnboarding", () => {
  it("does nothing until the operator opts into target inspection", async () => {
    const p = prompter([false]);
    const promptTarget = vi.fn();
    const sendMessage = vi.fn();
    await runCliqSetupOnboarding({
      cfg: configured(),
      prompter: p.value,
      deps: {
        promptTarget,
        resolveClient: () => ({ sendMessage }) as never,
      },
    });
    expect(promptTarget).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("shows visible/subscribed state and sends one DM only after the second confirmation", async () => {
    const p = prompter([true, true]);
    const sendMessage = vi.fn(async () => ({
      chatId: "CT_sensitive_identifier",
      messageId: "MSG_sensitive_identifier",
    }));
    const promptTarget = vi
      .fn()
      .mockResolvedValueOnce({ input: "Ada", id: "user-1", label: "Ada", resolved: true })
      .mockResolvedValueOnce(null);
    await runCliqSetupOnboarding({
      cfg: configured(),
      prompter: p.value,
      deps: {
        promptTarget,
        resolveClient: () => ({
          sendMessage,
          listBots: vi.fn(),
          getBot: vi.fn(),
          listBotSubscribers: vi.fn(),
          readBotHandlerScript: vi.fn(),
        }) as never,
        inspectBot: vi.fn(async () => inspection()),
      },
    });
    expect(promptTarget).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "user" }),
    );
    expect(promptTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "group" }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(p.notes.join(" ")).toMatch(/organization/);
    expect(p.notes.join(" ")).toMatch(/subscription state: subscribed/);
    expect(p.notes.join(" ")).not.toContain("sensitive_identifier");
  });

  it("reports unknown subscription without guessing when the subscriber list is unavailable", async () => {
    const p = prompter([true, false]);
    const promptTarget = vi
      .fn()
      .mockResolvedValueOnce({ input: "Ada", id: "user-1", label: "Ada", resolved: true })
      .mockResolvedValueOnce(null);
    const sendMessage = vi.fn();
    await runCliqSetupOnboarding({
      cfg: configured(),
      prompter: p.value,
      deps: {
        promptTarget,
        resolveClient: () => ({
          sendMessage,
          listBots: vi.fn(),
          getBot: vi.fn(),
          listBotSubscribers: vi.fn(),
          readBotHandlerScript: vi.fn(),
        }) as never,
        inspectBot: vi.fn(async () => inspection({
          subscribers: {
            state: "unknown",
            reason: "unknown because Zoho limits this read to the bot creator or an organization administrator",
          },
        })),
      },
    });
    expect(p.notes.join(" ")).toMatch(/subscription state: unknown/i);
    expect(p.notes.join(" ")).not.toMatch(/not.?subscribed/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("explains channel addition and mention policy without sending to the channel", async () => {
    const p = prompter([true]);
    const promptTarget = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ input: "Dev", id: "dev-team", label: "Dev Team", resolved: true });
    const sendMessage = vi.fn();
    await runCliqSetupOnboarding({
      cfg: configured(),
      prompter: p.value,
      deps: {
        promptTarget,
        resolveClient: () => ({ sendMessage }) as never,
      },
    });
    expect(p.notes.join(" ")).toMatch(/Add the bot/);
    expect(p.notes.join(" ")).toMatch(/@mention/);
    expect(p.notes.join(" ")).toMatch(/trusted-organization/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("runCliqSetupOnboarding report (issue #92)", () => {
  it("reports cancellation without treating it as a failed message test", async () => {
    const p = prompter([false]);
    const result = await runCliqSetupOnboarding({
      cfg: configured(),
      prompter: p.value,
      deps: { promptTarget: vi.fn() },
    });
    expect(result).toEqual({ status: "cancelled", firstContact: "not_requested", nextAction: "Rerun setup when you want to inspect targets or send a first-contact message." });
  });

  it("reports invalid credentials as resumable rather than throwing", async () => {
    const p = prompter([true]);
    const result = await runCliqSetupOnboarding({
      cfg: cfgWith({}),
      prompter: p.value,
      deps: { resolveAccount: () => { throw new Error("invalid credentials"); } },
    });
    expect(result.status).toBe("blocked");
    expect(result.nextAction).toMatch(/credentials/i);
  });
});
