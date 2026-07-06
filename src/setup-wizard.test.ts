import { describe, it, expect } from "vitest";
import {
  cliqSetupWizard,
  isCliqChannelConfigured,
  promptCliqCredentials,
  applyCliqCredentials,
  promptCliqDataCenter,
  applyCliqDataCenter,
  detectConfiguredCliqDataCenter,
  resolveCliqDataCenterOrEu,
  CLIQ_ENV_VARS,
} from "./setup-wizard.js";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { createCliqTestConfig as cfgWith } from "./test-api.js";

interface ScriptedCall {
  method: "text" | "confirm" | "note" | "select";
  args: Record<string, unknown>;
}

/**
 * A deterministic prompter that walks a queue of scripted (method, response)
 * pairs and records every call so tests can assert the prompting flow.
 */
function makeScriptedPrompter(
  responses: Array<
    { method: "text"; value: string } | { method: "confirm"; value: boolean } | { method: "select"; value: string }
  >,
): { prompter: WizardPrompter; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const queue = [...responses];
  const next = (
    method: "text" | "confirm" | "select",
  ): string | boolean => {
    if (queue.length === 0) {
      throw new Error(
        `prompter.${method}: no more scripted responses (calls so far: ${calls.length})`,
      );
    }
    const item = queue.shift()!;
    if (item.method !== method) {
      throw new Error(
        `expected prompter.${item.method} call but got prompter.${method}`,
      );
    }
    return item.value;
  };
  const prompter: WizardPrompter = {
    intro: async () => {},
    outro: async () => {},
    note: async (message: string, title?: string) => {
      calls.push({ method: "note", args: { message, title } });
    },
    select: async (params) => {
      calls.push({ method: "select", args: params as Record<string, unknown> });
      return String(next("select")) as never;
    },
    multiselect: async () => {
      throw new Error("multiselect not scripted");
    },
    text: async (params) => {
      calls.push({ method: "text", args: params as Record<string, unknown> });
      return String(next("text"));
    },
    confirm: async (params) => {
      calls.push({ method: "confirm", args: params as Record<string, unknown> });
      return Boolean(next("confirm"));
    },
    progress: () => ({ update: () => {}, stop: () => {} }),
  };
  return { prompter, calls };
}

describe("isCliqChannelConfigured", () => {
  it("returns true when clientId, clientSecret, and botId are set", () => {
    expect(
      isCliqChannelConfigured(
        cfgWith({ clientId: "id", clientSecret: "secret", botId: "bot" }),
      ),
    ).toBe(true);
  });

  it("returns false when any required field is missing", () => {
    expect(isCliqChannelConfigured(cfgWith({ clientId: "id" }))).toBe(false);
    expect(
      isCliqChannelConfigured(
        cfgWith({ clientId: "id", clientSecret: "secret" }),
      ),
    ).toBe(false);
    expect(isCliqChannelConfigured(cfgWith({}))).toBe(false);
  });

  it("ignores empty-string values", () => {
    expect(
      isCliqChannelConfigured(
        cfgWith({ clientId: "", clientSecret: "s", botId: "b" }),
      ),
    ).toBe(false);
  });
});

describe("applyCliqCredentials", () => {
  it("writes provided fields into channels.cliq and enables the channel", () => {
    const next = applyCliqCredentials(cfgWith({}), {
      clientId: "CID",
      clientSecret: "SECRET",
      botId: "bot",
      botName: "OpenClaw",
      webhookSecret: "WH",
      refreshToken: "RT",
    });
    const section = (next as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.clientId).toBe("CID");
    expect(section.clientSecret).toBe("SECRET");
    expect(section.botId).toBe("bot");
    expect(section.botName).toBe("OpenClaw");
    expect(section.webhookSecret).toBe("WH");
    expect(section.refreshToken).toBe("RT");
    expect(section.enabled).toBe(true);
  });

  it("preserves existing fields not being patched", () => {
    const next = applyCliqCredentials(
      cfgWith({ clientId: "old-id", clientSecret: "old-s", allowFrom: ["a"] }),
      { botId: "newbot" },
    );
    const section = (next as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.clientId).toBe("old-id");
    expect(section.clientSecret).toBe("old-s");
    expect(section.botId).toBe("newbot");
    expect(section.allowFrom).toEqual(["a"]);
  });

  it("does not set botName/webhookSecret/refreshToken when undefined", () => {
    const next = applyCliqCredentials(cfgWith({}), {
      clientId: "CID",
      clientSecret: "S",
      botId: "b",
    });
    const section = (next as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.botName).toBeUndefined();
    expect(section.webhookSecret).toBeUndefined();
    expect(section.refreshToken).toBeUndefined();
  });
});

describe("promptCliqCredentials — fresh setup (no existing config)", () => {
  it("prompts for the three required fields + optional botName + webhookSecret + refreshToken", async () => {
    // Order: clientId(text), clientSecret(text), botId(text), botName(text), webhookSecret(text), refreshToken(text)
    const { prompter, calls } = makeScriptedPrompter([
      { method: "text", value: "CID" },
      { method: "text", value: "SECRET" },
      { method: "text", value: "bot" },
      { method: "text", value: "OpenClaw" },
      { method: "text", value: "WH" },
      { method: "text", value: "RT" },
    ]);
    const creds = await promptCliqCredentials(prompter, cfgWith({}));
    expect(creds).toEqual({
      clientId: "CID",
      clientSecret: "SECRET",
      botId: "bot",
      botName: "OpenClaw",
      webhookSecret: "WH",
      refreshToken: "RT",
    });
    // No "keep existing" confirms, since nothing is configured.
    const confirms = calls.filter((c) => c.method === "confirm");
    expect(confirms).toHaveLength(0);
  });

  it("allows empty botName and empty webhookSecret and empty refreshToken (become undefined)", async () => {
    const { prompter } = makeScriptedPrompter([
      { method: "text", value: "CID" },
      { method: "text", value: "SECRET" },
      { method: "text", value: "bot" },
      { method: "text", value: "" },
      { method: "text", value: "" },
      { method: "text", value: "" },
    ]);
    const creds = await promptCliqCredentials(prompter, cfgWith({}));
    expect(creds.botName).toBeUndefined();
    expect(creds.webhookSecret).toBeUndefined();
    expect(creds.refreshToken).toBeUndefined();
  });
});

describe("promptCliqCredentials — re-running over existing config", () => {
  it("asks to keep each existing field and keeps it on 'yes'", async () => {
    const existing = cfgWith({
      clientId: "CID",
      clientSecret: "SECRET",
      botId: "bot",
      botName: "OpenClaw",
      webhookSecret: "WH",
      refreshToken: "RT",
    });
    // Order of confirms: keep clientId? clientSecret? botId? botName? webhookSecret? refreshToken?
    const { prompter, calls } = makeScriptedPrompter([
      { method: "confirm", value: true },
      { method: "confirm", value: true },
      { method: "confirm", value: true },
      { method: "confirm", value: true },
      { method: "confirm", value: true },
      { method: "confirm", value: true },
    ]);
    const creds = await promptCliqCredentials(prompter, existing);
    expect(creds).toEqual({
      clientId: "CID",
      clientSecret: "SECRET",
      botId: "bot",
      botName: "OpenClaw",
      webhookSecret: "WH",
      refreshToken: "RT",
    });
    const texts = calls.filter((c) => c.method === "text");
    expect(texts).toHaveLength(0);
  });

  it("on 'no' to keep clientId, re-prompts for it", async () => {
    const existing = cfgWith({
      clientId: "old",
      clientSecret: "SECRET",
      botId: "bot",
      botName: "OpenClaw",
      webhookSecret: "WH",
      refreshToken: "RT",
    });
    const { prompter } = makeScriptedPrompter([
      { method: "confirm", value: false }, // keep clientId? no
      { method: "text", value: "NEWCID" }, // re-enter clientId
      { method: "confirm", value: true }, // keep clientSecret
      { method: "confirm", value: true }, // keep botId
      { method: "confirm", value: true }, // keep botName
      { method: "confirm", value: true }, // keep webhookSecret
      { method: "confirm", value: true }, // keep refreshToken
    ]);
    const creds = await promptCliqCredentials(prompter, existing);
    expect(creds.clientId).toBe("NEWCID");
    expect(creds.clientSecret).toBe("SECRET");
  });
});

describe("promptCliqCredentials — env var shortcut", () => {
  it("offers to use CLIQ_CLIENT_ID from the environment when nothing is configured", async () => {
    process.env[CLIQ_ENV_VARS.clientId] = "ENV_CID";
    try {
      const { prompter, calls } = makeScriptedPrompter([
        { method: "confirm", value: true }, // use env? yes
        { method: "text", value: "SECRET" },
        { method: "text", value: "bot" },
        { method: "text", value: "" },
        { method: "text", value: "" },
        { method: "text", value: "" },
      ]);
      const creds = await promptCliqCredentials(prompter, cfgWith({}));
      expect(creds.clientId).toBe("ENV_CID");
      // first call is the env confirm, then a text for clientSecret
      expect(calls[0].method).toBe("confirm");
    } finally {
      delete process.env[CLIQ_ENV_VARS.clientId];
    }
  });

  it("offers env when the operator declines to keep an existing value", async () => {
    process.env[CLIQ_ENV_VARS.clientSecret] = "ENV_SECRET";
    try {
      const existing = cfgWith({
        clientId: "CID",
        clientSecret: "old",
        botId: "bot",
        botName: "OpenClaw",
        webhookSecret: "WH",
        refreshToken: "RT",
      });
      const { prompter } = makeScriptedPrompter([
        { method: "confirm", value: true }, // keep clientId
        { method: "confirm", value: false }, // keep clientSecret? no
        { method: "confirm", value: true }, // use env clientSecret? yes
        { method: "confirm", value: true }, // keep botId
        { method: "confirm", value: true }, // keep botName
        { method: "confirm", value: true }, // keep webhookSecret
        { method: "confirm", value: true }, // keep refreshToken
      ]);
      const creds = await promptCliqCredentials(prompter, existing);
      expect(creds.clientSecret).toBe("ENV_SECRET");
    } finally {
      delete process.env[CLIQ_ENV_VARS.clientSecret];
    }
  });
});

describe("cliqSetupWizard", () => {
  it("targets the cliq channel", () => {
    expect(cliqSetupWizard.channel).toBe("cliq");
  });

  it("status.resolveConfigured reflects the configured check", async () => {
    expect(
      await cliqSetupWizard.status.resolveConfigured({
        cfg: cfgWith({ clientId: "id", clientSecret: "s", botId: "b" }),
      }),
    ).toBe(true);
    expect(
      await cliqSetupWizard.status.resolveConfigured({ cfg: cfgWith({}) }),
    ).toBe(false);
  });

  it("disable() sets the channel disabled flag", () => {
    const next = cliqSetupWizard.disable!(cfgWith({ clientId: "id" }));
    const section = (next as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.enabled).toBe(false);
  });

  it("dmPolicy reads the configured policy with allowlist default", () => {
    expect(
      cliqSetupWizard.dmPolicy!.getCurrent(cfgWith({})),
    ).toBe("allowlist");
    expect(
      cliqSetupWizard.dmPolicy!.getCurrent(cfgWith({ dmPolicy: "open" })),
    ).toBe("open");
  });

  it("finalize writes the collected credentials into config", async () => {
    const { prompter } = makeScriptedPrompter([
      { method: "select", value: "eu" },
      { method: "text", value: "CID" },
      { method: "text", value: "SECRET" },
      { method: "text", value: "bot" },
      { method: "text", value: "OpenClaw" },
      { method: "text", value: "WH" },
      { method: "text", value: "RT" },
    ]);
    const result = await cliqSetupWizard.finalize!({
      cfg: cfgWith({}),
      accountId: "default",
      credentialValues: {},
      runtime: {} as never,
      prompter,
      forceAllowFrom: false,
    });
    const section = (
      result!.cfg as unknown as { channels: { cliq: Record<string, unknown> } }
    ).channels.cliq;
    expect(section.clientId).toBe("CID");
    expect(section.clientSecret).toBe("SECRET");
    expect(section.botId).toBe("bot");
    expect(section.botName).toBe("OpenClaw");
    expect(section.webhookSecret).toBe("WH");
    expect(section.refreshToken).toBe("RT");
    expect(section.enabled).toBe(true);
    // The DC prompt writes oauthBase + apiBase together (issue #46).
    expect(section.oauthBase).toBe("https://accounts.zoho.eu");
    expect(section.apiBase).toBe("https://cliq.zoho.eu");
  });

  it("finalize writes the chosen region's oauthBase + apiBase and uses its console URL in the note", async () => {
    const { prompter, calls } = makeScriptedPrompter([
      { method: "select", value: "us" },
      { method: "text", value: "CID" },
      { method: "text", value: "SECRET" },
      { method: "text", value: "bot" },
      { method: "text", value: "" },
      { method: "text", value: "" },
      { method: "text", value: "" },
    ]);
    const result = await cliqSetupWizard.finalize!({
      cfg: cfgWith({}),
      accountId: "default",
      credentialValues: {},
      runtime: {} as never,
      prompter,
      forceAllowFrom: false,
    });
    const section = (
      result!.cfg as unknown as { channels: { cliq: Record<string, unknown> } }
    ).channels.cliq;
    expect(section.oauthBase).toBe("https://accounts.zoho.com");
    expect(section.apiBase).toBe("https://cliq.zoho.com");
    // The setup note references the chosen region's API Console URL, not the
    // hard-coded EU one (issue #46).
    const noteCall = calls.find((c) => c.method === "note");
    expect(noteCall).toBeDefined();
    expect(noteCall!.args.message).toContain("https://api-console.zoho.com");
    expect(noteCall!.args.message).not.toContain("api-console.zoho.eu");
  });
});

describe("promptCliqDataCenter — data-center prompt (issue #46)", () => {
  it("prompts with EU as the default when no region is configured", async () => {
    const { prompter, calls } = makeScriptedPrompter([
      { method: "select", value: "eu" },
    ]);
    const id = await promptCliqDataCenter(prompter, cfgWith({}));
    expect(id).toBe("eu");
    const selectCall = calls.find((c) => c.method === "select");
    expect(selectCall).toBeDefined();
    expect(selectCall!.args.initialValue).toBe("eu");
  });

  it("reuses the existing region on re-run (does not reset to EU)", async () => {
    const existing = cfgWith({
      oauthBase: "https://accounts.zoho.com",
      apiBase: "https://cliq.zoho.com",
    });
    const { prompter, calls } = makeScriptedPrompter([
      { method: "select", value: "us" },
    ]);
    const id = await promptCliqDataCenter(prompter, existing);
    expect(id).toBe("us");
    const selectCall = calls.find((c) => c.method === "select");
    expect(selectCall!.args.initialValue).toBe("us");
  });

  it("falls back to detecting the region from apiBase when oauthBase is absent", async () => {
    const existing = cfgWith({ apiBase: "https://cliq.zoho.in" });
    const { prompter, calls } = makeScriptedPrompter([
      { method: "select", value: "in" },
    ]);
    const id = await promptCliqDataCenter(prompter, existing);
    expect(id).toBe("in");
    const selectCall = calls.find((c) => c.method === "select");
    expect(selectCall!.args.initialValue).toBe("in");
  });

  it("defaults to EU when the configured oauthBase is not a known region", async () => {
    const existing = cfgWith({
      oauthBase: "https://accounts.example.internal",
      apiBase: "https://cliq.example.internal",
    });
    const { prompter, calls } = makeScriptedPrompter([
      { method: "select", value: "eu" },
    ]);
    const id = await promptCliqDataCenter(prompter, existing);
    expect(id).toBe("eu");
    const selectCall = calls.find((c) => c.method === "select");
    expect(selectCall!.args.initialValue).toBe("eu");
  });
});

describe("applyCliqDataCenter", () => {
  it("writes oauthBase + apiBase together for a known region", () => {
    const next = applyCliqDataCenter(cfgWith({}), "us");
    const section = (next as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.oauthBase).toBe("https://accounts.zoho.com");
    expect(section.apiBase).toBe("https://cliq.zoho.com");
  });

  it("falls back to EU for an unknown region id", () => {
    const next = applyCliqDataCenter(cfgWith({}), "zz");
    const section = (next as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.oauthBase).toBe("https://accounts.zoho.eu");
    expect(section.apiBase).toBe("https://cliq.zoho.eu");
  });

  it("preserves existing fields not being patched", () => {
    const next = applyCliqDataCenter(
      cfgWith({ clientId: "id", botId: "bot" }),
      "in",
    );
    const section = (next as unknown as { channels: { cliq: Record<string, unknown> } })
      .channels.cliq;
    expect(section.clientId).toBe("id");
    expect(section.botId).toBe("bot");
    expect(section.oauthBase).toBe("https://accounts.zoho.in");
  });
});

describe("detectConfiguredCliqDataCenter", () => {
  it("detects the region from oauthBase", () => {
    expect(
      detectConfiguredCliqDataCenter(
        cfgWith({ oauthBase: "https://accounts.zoho.jp" }),
      ),
    ).toBe("jp");
  });

  it("detects the region from apiBase when oauthBase is absent", () => {
    expect(
      detectConfiguredCliqDataCenter(cfgWith({ apiBase: "https://cliq.zoho.com.au" })),
    ).toBe("au");
  });

  it("returns undefined when neither matches a known region", () => {
    expect(detectConfiguredCliqDataCenter(cfgWith({}))).toBeUndefined();
    expect(
      detectConfiguredCliqDataCenter(
        cfgWith({ oauthBase: "https://accounts.example.internal" }),
      ),
    ).toBeUndefined();
  });
});

describe("resolveCliqDataCenterOrEu", () => {
  it("resolves a known id", () => {
    expect(resolveCliqDataCenterOrEu("ca").id).toBe("ca");
  });

  it("falls back to EU for undefined / unknown", () => {
    expect(resolveCliqDataCenterOrEu(undefined).id).toBe("eu");
    expect(resolveCliqDataCenterOrEu("zz").id).toBe("eu");
  });
});
