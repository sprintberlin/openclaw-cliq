import { describe, it, expect, vi } from "vitest";
import {
  promptCliqPublicWebhookUrl,
  applyCliqPublicWebhookUrl,
  verifyCliqInboundDuringSetup,
} from "./setup-wizard.js";
import { createCliqTestConfig as cfgWith } from "./test-api.js";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";

function prompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    select: vi.fn(async () => ""),
    note: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WizardPrompter;
}

describe("promptCliqPublicWebhookUrl (issue #96)", () => {
  it("prompts for the public URL when none is configured", async () => {
    const text = vi.fn(async () => "https://host.example.com/cliq/webhook");
    const url = await promptCliqPublicWebhookUrl(prompter({ text } as never), cfgWith({}));
    expect(url).toBe("https://host.example.com/cliq/webhook");
  });

  it("offers to keep an already-configured URL", async () => {
    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "https://other.example.com/cliq/webhook");
    const url = await promptCliqPublicWebhookUrl(
      prompter({ confirm, text } as never),
      cfgWith({ publicWebhookUrl: "https://kept.example.com/cliq/webhook" }),
    );
    expect(url).toBe("https://kept.example.com/cliq/webhook");
    expect(text).not.toHaveBeenCalled();
  });

  it("returns undefined when the operator skips the URL", async () => {
    const text = vi.fn(async () => "   ");
    const url = await promptCliqPublicWebhookUrl(prompter({ text } as never), cfgWith({}));
    expect(url).toBeUndefined();
  });
});

describe("applyCliqPublicWebhookUrl (issue #96)", () => {
  it("stores the URL in the channel section", () => {
    const next = applyCliqPublicWebhookUrl(cfgWith({}), "https://host.example.com/cliq/webhook");
    const section = (next as never as { channels: { cliq: Record<string, unknown> } }).channels.cliq;
    expect(section.publicWebhookUrl).toBe("https://host.example.com/cliq/webhook");
  });

  it("leaves the config untouched when there is no URL", () => {
    const cfg = cfgWith({ botId: "b" });
    expect(applyCliqPublicWebhookUrl(cfg, undefined)).toBe(cfg);
  });
});

describe("verifyCliqInboundDuringSetup (issue #96)", () => {
  const PASS = { ok: true, url: "u", nonce: "n", dispatched: false, stages: [] };
  const FAIL = {
    ok: false,
    url: "u",
    nonce: "n",
    dispatched: false,
    stages: [{ id: "method", label: "Route", status: "fail", detail: "404 from the proxy" }],
  };

  it("reports inbound ready after a passing preflight", async () => {
    const note = vi.fn(async () => {});
    const result = await verifyCliqInboundDuringSetup({
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        webhookSecret: "w",
      }),
      url: "https://host.example.com/cliq/webhook",
      prompter: prompter({ note } as never),
      runPreflight: async () => PASS as never,
    });
    expect(result.ready).toBe(true);
    expect(note).toHaveBeenCalled();
  });

  it("REFUSES to report inbound ready when the preflight fails", async () => {
    const result = await verifyCliqInboundDuringSetup({
      cfg: cfgWith({ clientId: "c", clientSecret: "s", botId: "b", webhookSecret: "w" }),
      url: "https://host.example.com/cliq/webhook",
      prompter: prompter(),
      runPreflight: async () => FAIL as never,
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("404 from the proxy");
  });

  it("REFUSES to report inbound ready when no public URL was provided", async () => {
    const runPreflight = vi.fn(async () => PASS as never);
    const result = await verifyCliqInboundDuringSetup({
      cfg: cfgWith({ clientId: "c", clientSecret: "s", botId: "b", webhookSecret: "w" }),
      url: undefined,
      prompter: prompter(),
      runPreflight,
    });
    expect(result.ready).toBe(false);
    expect(runPreflight).not.toHaveBeenCalled();
  });

  it("surfaces the failure to the operator instead of failing silently", async () => {
    const note = vi.fn(async () => {});
    await verifyCliqInboundDuringSetup({
      cfg: cfgWith({ clientId: "c", clientSecret: "s", botId: "b", webhookSecret: "w" }),
      url: "https://host.example.com/cliq/webhook",
      prompter: prompter({ note } as never),
      runPreflight: async () => FAIL as never,
    });
    const noted = (note.mock.calls as unknown as Array<[string, string?]>)
      .map(([message]) => message)
      .join("\n");
    expect(noted).toContain("404 from the proxy");
  });

  it("never lets a preflight crash abort the wizard", async () => {
    const result = await verifyCliqInboundDuringSetup({
      cfg: cfgWith({ clientId: "c", clientSecret: "s", botId: "b", webhookSecret: "w" }),
      url: "https://host.example.com/cliq/webhook",
      prompter: prompter(),
      runPreflight: async () => {
        throw new Error("boom");
      },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/boom|failed/i);
  });
});
