import { describe, it, expect, vi } from "vitest";
import {
  promptCliqPublicWebhookUrl,
  applyCliqPublicWebhookUrl,
  applyCliqInboundVerification,
  verifyCliqInboundDuringSetup,
  cliqSetupWizard,
} from "./setup-wizard.js";
import { createCliqTestConfig as cfgWith } from "./test-api.js";
import { resolveCliqConfig } from "./client.js";
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

describe("setup status surfaces inbound verification (issue #96)", () => {
  const base = {
    clientId: "c",
    clientSecret: "s",
    botId: "b",
    webhookSecret: "w",
  };

  async function lines(section: Record<string, unknown>): Promise<string[]> {
    return (
      (await cliqSetupWizard.status.resolveStatusLines?.({
        cfg: cfgWith(section),
        accountId: "default",
        configured: true,
      })) ?? []
    );
  }

  it("reports inbound as never checked when setup never verified the public webhook", async () => {
    expect((await lines(base)).join("\n")).toMatch(/inbound.*never checked/i);
  });

  it("distinguishes a failed last check from never having checked (issue #106)", async () => {
    const failed = (
      await lines({
        ...base,
        publicWebhookUrl: "https://host.example.com/cliq/webhook",
        inboundVerificationFailedAt: "2026-08-27T09:00:00.000Z",
      })
    ).join("\n");
    const never = (
      await lines({ ...base, publicWebhookUrl: "https://host.example.com/cliq/webhook" })
    ).join("\n");
    expect(failed).toMatch(/failed/i);
    expect(failed).toContain("2026-08-27T09:00:00.000Z");
    expect(never).toMatch(/never checked/i);
    expect(never).not.toMatch(/failed/i);
  });

  it("reports the verified public URL once verification succeeded", async () => {
    const out = (
      await lines({
        ...base,
        publicWebhookUrl: "https://host.example.com/cliq/webhook",
        inboundVerifiedAt: "2026-08-26T10:00:00.000Z",
      })
    ).join("\n");
    expect(out).toContain("https://host.example.com/cliq/webhook");
    expect(out).toMatch(/verified/i);
  });

  it("does not claim verification when only a URL is configured", async () => {
    const out = (
      await lines({
        ...base,
        publicWebhookUrl: "https://host.example.com/cliq/webhook",
      })
    ).join("\n");
    expect(out).not.toMatch(/inbound: verified/i);
    expect(out).toMatch(/never checked/i);
  });

  it("reports a SecretRef-configured webhook secret as set (same asString class of bug)", async () => {
    const out = (
      await lines({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        webhookSecret: { source: "env", id: "SOME_ENV_SECRET" },
      })
    ).join("\n");
    expect(out).toContain("webhook secret: set");
  });

  it("still reports a missing webhook secret as not set", async () => {
    const out = (
      await lines({ clientId: "c", clientSecret: "s", botId: "b" })
    ).join("\n");
    expect(out).toContain("webhook secret: not set");
  });
});

describe("applyCliqInboundVerification (issue #96)", () => {
  it("records a timestamp when inbound was verified", () => {
    const next = applyCliqInboundVerification(cfgWith({ botId: "b" }), {
      ready: true,
      reason: "ok",
    });
    const section = (next as never as { channels: { cliq: Record<string, unknown> } }).channels.cliq;
    expect(typeof section.inboundVerifiedAt).toBe("string");
  });

  it("clears a stale timestamp when a later run is not ready", () => {
    const verified = applyCliqInboundVerification(cfgWith({ botId: "b" }), {
      ready: true,
      reason: "ok",
    });
    const next = applyCliqInboundVerification(verified, { ready: false, reason: "unreachable" });
    const section = (next as never as { channels: { cliq: Record<string, unknown> } }).channels.cliq;
    expect(section.inboundVerifiedAt).toBeUndefined();
    // Cleared means the key is gone, not present-with-undefined: how a writer
    // serializes undefined must not decide whether the stale claim survives.
    expect("inboundVerifiedAt" in section).toBe(false);
  });

  it("records when the failing check happened so status can say 'last check failed' (issue #106)", () => {
    const next = applyCliqInboundVerification(cfgWith({ botId: "b" }), {
      ready: false,
      reason: "unreachable",
    });
    const section = (next as never as { channels: { cliq: Record<string, unknown> } }).channels.cliq;
    expect(typeof section.inboundVerificationFailedAt).toBe("string");
  });

  it("preserves both verification timestamps when a later run is inconclusive", () => {
    const cfg = cfgWith({
      botId: "b",
      inboundVerifiedAt: "2026-08-27T08:00:00.000Z",
      inboundVerificationFailedAt: "2026-08-26T08:00:00.000Z",
    });
    const next = applyCliqInboundVerification(cfg, {
      ready: false,
      inconclusive: true,
      reason: "gateway returned 502 after bounded readiness retries",
    });
    const section = (next as never as { channels: { cliq: Record<string, unknown> } }).channels.cliq;
    expect(next).toBe(cfg);
    expect(section.inboundVerifiedAt).toBe("2026-08-27T08:00:00.000Z");
    expect(section.inboundVerificationFailedAt).toBe("2026-08-26T08:00:00.000Z");
  });

  it("clears a recorded failure once a later run verifies successfully", () => {
    const failed = applyCliqInboundVerification(cfgWith({ botId: "b" }), {
      ready: false,
      reason: "unreachable",
    });
    const next = applyCliqInboundVerification(failed, { ready: true, reason: "ok" });
    const section = (next as never as { channels: { cliq: Record<string, unknown> } }).channels.cliq;
    expect(section.inboundVerificationFailedAt).toBeUndefined();
    expect(typeof section.inboundVerifiedAt).toBe("string");
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

  it("returns an inconclusive setup result for a warn-only transient preflight", async () => {
    const result = await verifyCliqInboundDuringSetup({
      cfg: cfgWith({ clientId: "c", clientSecret: "s", botId: "b", webhookSecret: "w" }),
      url: "https://host.example.com/cliq/webhook",
      prompter: prompter(),
      runPreflight: async () => ({
        ...FAIL,
        stages: [
          {
            id: "method",
            label: "Route",
            status: "warn",
            detail: "gateway returned 502 after bounded readiness retries",
          },
        ],
      }) as never,
    });
    expect(result.ready).toBe(false);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toMatch(/inconclusive|502/i);
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

  it("resolves an env-backed SecretRef webhookSecret instead of skipping the probe", async () => {
    // The exact config shape `openclaw secrets apply` produces. asString()
    // returns undefined for it, which used to make setup run the preflight
    // with no secret and report a correctly configured install as NOT ready.
    process.env.CLIQ_WH_SECRET_TEST = "env-secret-1";
    try {
      let received: string | undefined = "unset";
      const result = await verifyCliqInboundDuringSetup({
        cfg: cfgWith({
          clientId: "c",
          clientSecret: "s",
          botId: "b",
          webhookSecret: { source: "env", id: "CLIQ_WH_SECRET_TEST" },
        }),
        url: "https://host.example.com/cliq/webhook",
        prompter: prompter(),
        runPreflight: async (options) => {
          received = options.secret;
          return PASS as never;
        },
      });
      expect(received).toBe("env-secret-1");
      expect(result.ready).toBe(true);
    } finally {
      delete process.env.CLIQ_WH_SECRET_TEST;
    }
  });

  it("sends exactly the secret the runtime handler compares against for a '$VAR' shorthand", async () => {
    // The SDK's sync resolution does NOT expand a bare "$VAR" shorthand:
    // resolveCliqConfig() yields the literal string too, so the webhook
    // handler compares the header against that literal. The preflight must
    // therefore send the same literal — anything "smarter" here would send a
    // secret the running plugin does not accept.
    process.env.CLIQ_WH_SHORTHAND = "real-secret";
    try {
      let received: string | undefined = "unset";
      await verifyCliqInboundDuringSetup({
        cfg: cfgWith({
          clientId: "c",
          clientSecret: "s",
          botId: "b",
          webhookSecret: "$CLIQ_WH_SHORTHAND",
        }),
        url: "https://host.example.com/cliq/webhook",
        prompter: prompter(),
        runPreflight: async (options) => {
          received = options.secret;
          return PASS as never;
        },
      });
      const runtimeSecret = resolveCliqConfig(
        cfgWith({
          clientId: "c",
          clientSecret: "s",
          botId: "b",
          webhookSecret: "$CLIQ_WH_SHORTHAND",
        }),
        null,
      ).webhookSecret;
      expect(received).toBe(runtimeSecret);
    } finally {
      delete process.env.CLIQ_WH_SHORTHAND;
    }
  });

  it("still passes a plaintext webhookSecret through unchanged", async () => {
    let received: string | undefined;
    await verifyCliqInboundDuringSetup({
      cfg: cfgWith({ clientId: "c", clientSecret: "s", botId: "b", webhookSecret: "plain" }),
      url: "https://host.example.com/cliq/webhook",
      prompter: prompter(),
      runPreflight: async (options) => {
        received = options.secret;
        return PASS as never;
      },
    });
    expect(received).toBe("plain");
  });

  it("never lets a throwing prompter abort the wizard after credentials were written", async () => {
    const result = await verifyCliqInboundDuringSetup({
      cfg: cfgWith({ clientId: "c", clientSecret: "s", botId: "b", webhookSecret: "w" }),
      url: "https://host.example.com/cliq/webhook",
      prompter: prompter({
        note: async () => {
          throw new Error("no TTY");
        },
      } as never),
      runPreflight: async () => PASS as never,
    });
    expect(result.ready).toBe(true);
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
