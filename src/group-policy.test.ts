import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-runtime";
import {
  cliqGroupsAdapter,
  resolveCliqGroupId,
  resolveCliqGroupRequireMention,
  resolveCliqGroupToolPolicy,
} from "./group-policy.js";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

function ctx(over: Partial<ChannelGroupContext> = {}): ChannelGroupContext {
  return {
    cfg: cfgWith({ clientId: "c", clientSecret: "s", botId: "b" }),
    groupId: "dev-team",
    accountId: "default",
    senderId: "12345",
    senderName: "Alice",
    ...over,
  };
}

describe("resolveCliqGroupId", () => {
  it("prefers groupId", () => {
    expect(
      resolveCliqGroupId(ctx({ groupId: "dev-team", groupChannel: "Dev Team" })),
    ).toBe("dev-team");
  });

  it("falls back to groupChannel when groupId is absent", () => {
    expect(
      resolveCliqGroupId(ctx({ groupId: null, groupChannel: "Dev Team" })),
    ).toBe("Dev Team");
  });

  it("falls back to groupSpace when groupChannel is absent", () => {
    expect(
      resolveCliqGroupId(
        ctx({ groupId: null, groupChannel: null, groupSpace: "space-1" }),
      ),
    ).toBe("space-1");
  });

  it("returns null when no group id can be resolved", () => {
    expect(
      resolveCliqGroupId(ctx({ groupId: null, groupChannel: null, groupSpace: null })),
    ).toBeNull();
  });

  it("trims whitespace", () => {
    expect(resolveCliqGroupId(ctx({ groupId: "  dev-team  " }))).toBe(
      "dev-team",
    );
  });
});

describe("resolveCliqGroupRequireMention", () => {
  it("defaults to true when no groups are configured", () => {
    expect(resolveCliqGroupRequireMention(ctx())).toBe(true);
  });

  it("reads a per-group requireMention: false", () => {
    const c = ctx({
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: { "dev-team": { requireMention: false } },
      }),
    });
    expect(resolveCliqGroupRequireMention(c)).toBe(false);
  });

  it("reads the wildcard * default", () => {
    const c = ctx({
      groupId: "other-channel",
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: { "*": { requireMention: false } },
      }),
    });
    expect(resolveCliqGroupRequireMention(c)).toBe(false);
  });

  it("matches group keys case-insensitively", () => {
    const c = ctx({
      groupId: "DEV-TEAM",
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: { "dev-team": { requireMention: false } },
      }),
    });
    expect(resolveCliqGroupRequireMention(c)).toBe(false);
  });

  it("returns undefined when no group id can be resolved", () => {
    expect(
      resolveCliqGroupRequireMention(
        ctx({ groupId: null, groupChannel: null, groupSpace: null }),
      ),
    ).toBeUndefined();
  });
});

describe("resolveCliqGroupToolPolicy", () => {
  it("returns undefined when no groups are configured", () => {
    expect(resolveCliqGroupToolPolicy(ctx())).toBeUndefined();
  });

  it("returns undefined when no group id can be resolved", () => {
    expect(
      resolveCliqGroupToolPolicy(
        ctx({ groupId: null, groupChannel: null, groupSpace: null }),
      ),
    ).toBeUndefined();
  });

  it("reads per-group tools policy", () => {
    const c = ctx({
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: {
          "dev-team": { tools: { allow: ["web"], deny: ["exec"] } },
        },
      }),
    });
    expect(resolveCliqGroupToolPolicy(c)).toEqual({
      allow: ["web"],
      deny: ["exec"],
    });
  });

  it("reads the wildcard * default tools policy", () => {
    const c = ctx({
      groupId: "other-channel",
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: { "*": { tools: { deny: ["exec"] } } },
      }),
    });
    expect(resolveCliqGroupToolPolicy(c)).toEqual({ deny: ["exec"] });
  });

  it("resolves toolsBySender keyed by channel:cliq:<senderId>", () => {
    const c = ctx({
      senderId: "12345",
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: {
          "dev-team": {
            toolsBySender: {
              "channel:cliq:12345": { allow: ["memory"] },
            },
          },
        },
      }),
    });
    expect(resolveCliqGroupToolPolicy(c)).toEqual({ allow: ["memory"] });
  });

  it("resolves toolsBySender keyed by id:<senderId>", () => {
    const c = ctx({
      senderId: "12345",
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: {
          "dev-team": {
            toolsBySender: {
              "id:12345": { deny: ["exec"] },
            },
          },
        },
      }),
    });
    expect(resolveCliqGroupToolPolicy(c)).toEqual({ deny: ["exec"] });
  });

  it("resolves toolsBySender keyed by name:<senderName>", () => {
    const c = ctx({
      senderId: "999",
      senderName: "Alice",
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: {
          "dev-team": {
            toolsBySender: {
              "name:Alice": { allow: ["web"] },
            },
          },
        },
      }),
    });
    expect(resolveCliqGroupToolPolicy(c)).toEqual({ allow: ["web"] });
  });

  it("matches group keys case-insensitively", () => {
    const c = ctx({
      groupId: "DEV-TEAM",
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: {
          "dev-team": { tools: { deny: ["exec"] } },
        },
      }),
    });
    expect(resolveCliqGroupToolPolicy(c)).toEqual({ deny: ["exec"] });
  });
});

describe("cliqGroupsAdapter", () => {
  it("exposes resolveRequireMention and resolveToolPolicy", () => {
    expect(typeof cliqGroupsAdapter.resolveRequireMention).toBe("function");
    expect(typeof cliqGroupsAdapter.resolveToolPolicy).toBe("function");
  });

  it("delegates resolveRequireMention to the resolver", () => {
    const c = ctx({
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: { "dev-team": { requireMention: false } },
      }),
    });
    expect(cliqGroupsAdapter.resolveRequireMention?.(c)).toBe(false);
  });

  it("delegates resolveToolPolicy to the resolver", () => {
    const c = ctx({
      cfg: cfgWith({
        clientId: "c",
        clientSecret: "s",
        botId: "b",
        groups: { "dev-team": { tools: { deny: ["exec"] } } },
      }),
    });
    expect(cliqGroupsAdapter.resolveToolPolicy?.(c)).toEqual({ deny: ["exec"] });
  });
});
