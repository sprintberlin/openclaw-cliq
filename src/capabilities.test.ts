import { describe, it, expect, vi } from "vitest";
import {
  CLIQ_CAPABILITIES,
  ALL_CAPABILITY_SCOPES,
  RUNTIME_REQUIRED_SCOPES,
  SETUP_SCOPES,
  RUNTIME_SCOPE_STRING,
  SETUP_SCOPE_STRING,
  FULL_SCOPE_STRING,
  probeCliqCapability,
  formatCapabilityReport,
  evaluateCliqScopeSet,
  getCapabilityById,
  getCapabilitiesByProfile,
  getRequiredScopesForProfile,
  type CliqCapabilityReport,
} from "./capabilities.js";

// ---------------------------------------------------------------------------
// Capability matrix structure
// ---------------------------------------------------------------------------

describe("CLIQ_CAPABILITIES", () => {
  it("contains entries", () => {
    expect(CLIQ_CAPABILITIES.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = CLIQ_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a scope", () => {
    for (const cap of CLIQ_CAPABILITIES) {
      expect(cap.scope).toBeTruthy();
      expect(cap.scope).toMatch(/^ZohoCliq\./);
    }
  });

  it("every entry has a label", () => {
    for (const cap of CLIQ_CAPABILITIES) {
      expect(cap.label).toBeTruthy();
    }
  });

  it("every entry has a missingHint", () => {
    for (const cap of CLIQ_CAPABILITIES) {
      expect(cap.missingHint).toBeTruthy();
    }
  });

  it("every entry has a valid grantType", () => {
    for (const cap of CLIQ_CAPABILITIES) {
      expect(["client_credentials", "refresh_token"]).toContain(cap.grantType);
    }
  });

  it("every entry has a valid profile", () => {
    for (const cap of CLIQ_CAPABILITIES) {
      expect(["runtime", "setup"]).toContain(cap.profile);
    }
  });

  it("every entry has a valid category", () => {
    for (const cap of CLIQ_CAPABILITIES) {
      expect(["messaging", "rich", "directory", "setup"]).toContain(cap.category);
    }
  });

  it("DM send is client_credentials, non-optional, runtime", () => {
    const dm = getCapabilityById("dm_send")!;
    expect(dm).toBeDefined();
    expect(dm.grantType).toBe("client_credentials");
    expect(dm.optional).toBe(false);
    expect(dm.profile).toBe("runtime");
  });

  it("Channel send is refresh_token, non-optional, runtime", () => {
    const ch = getCapabilityById("channel_send")!;
    expect(ch).toBeDefined();
    expect(ch.grantType).toBe("refresh_token");
    expect(ch.optional).toBe(false);
    expect(ch.profile).toBe("runtime");
  });

  it("Message edit is refresh_token, non-optional, runtime", () => {
    const edit = getCapabilityById("message_edit")!;
    expect(edit).toBeDefined();
    expect(edit.grantType).toBe("refresh_token");
    expect(edit.optional).toBe(false);
    expect(edit.profile).toBe("runtime");
  });

  it("Bot read is setup profile", () => {
    const botRead = getCapabilityById("bot_read")!;
    expect(botRead).toBeDefined();
    expect(botRead.profile).toBe("setup");
    expect(botRead.scope).toBe("ZohoCliq.Bots.READ");
  });

  it("Bot update is setup profile", () => {
    const botUpdate = getCapabilityById("bot_update")!;
    expect(botUpdate).toBeDefined();
    expect(botUpdate.profile).toBe("setup");
    expect(botUpdate.scope).toBe("ZohoCliq.Bots.UPDATE");
  });

  it("Bot create is its own setup capability on the client_credentials grant", () => {
    const botCreate = getCapabilityById("bot_create")!;
    expect(botCreate).toBeDefined();
    expect(botCreate.scope).toBe("ZohoCliq.Bots.CREATE");
    expect(botCreate.profile).toBe("setup");
    expect(botCreate.category).toBe("setup");
    expect(botCreate.grantType).toBe("client_credentials");
  });

  it("Bot create is reported from the granted scope set, never probed", () => {
    const botCreate = getCapabilityById("bot_create")!;
    expect(botCreate.probePath).toBeNull();
    expect(botCreate.scopeReportedOnly).toBe(true);
  });

  it("Bot read stays probe-free but is not a scope-reported-only capability", () => {
    const botRead = getCapabilityById("bot_read")!;
    expect(botRead.scopeReportedOnly).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Scope-set evaluation (issue #110)
// ---------------------------------------------------------------------------

describe("evaluateCliqScopeSet", () => {
  const runtimeScopes = RUNTIME_SCOPE_STRING.split(",");

  it("reports Bots.CREATE as missing for a READ+UPDATE consent", () => {
    const granted = [
      ...runtimeScopes,
      "ZohoCliq.Bots.READ",
      "ZohoCliq.Bots.UPDATE",
    ];
    const result = evaluateCliqScopeSet(granted);
    expect(result.missing).toContain("bot_create");
    expect(result.canCreateBots).toBe(false);
    expect(result.canInspectBots).toBe(true);
  });

  it("names ZohoCliq.Bots.CREATE explicitly instead of a generic scope error", () => {
    const granted = [
      ...runtimeScopes,
      "ZohoCliq.Bots.READ",
      "ZohoCliq.Bots.UPDATE",
    ];
    const result = evaluateCliqScopeSet(granted);
    const message = result.messages.join("\n");
    expect(message).toContain("ZohoCliq.Bots.CREATE");
    expect(message).toMatch(/create/i);
    expect(message).not.toMatch(/^The OAuth token passed does not have/);
  });

  it("reports bot creation as available once Bots.CREATE is consented", () => {
    const granted = [
      ...runtimeScopes,
      "ZohoCliq.Bots.READ",
      "ZohoCliq.Bots.CREATE",
      "ZohoCliq.Bots.UPDATE",
    ];
    const result = evaluateCliqScopeSet(granted);
    expect(result.canCreateBots).toBe(true);
    expect(result.missing).not.toContain("bot_create");
  });

  it("marks bot creation as consent-reported, not probed", () => {
    const granted = [...runtimeScopes, ...SETUP_SCOPE_STRING.split(",")];
    const result = evaluateCliqScopeSet(granted);
    expect(result.canCreateBots).toBe(true);
    expect(result.scopeReportedOnly).toContain("bot_create");
  });

  it("tolerates whitespace and empty entries in the granted scope list", () => {
    const result = evaluateCliqScopeSet([
      " ZohoCliq.Bots.READ ",
      "",
      "ZohoCliq.Bots.CREATE",
    ]);
    expect(result.canInspectBots).toBe(true);
    expect(result.canCreateBots).toBe(true);
  });

  it("accepts a raw comma-separated scope string", () => {
    const result = evaluateCliqScopeSet("ZohoCliq.Bots.READ,ZohoCliq.Bots.UPDATE");
    expect(result.canCreateBots).toBe(false);
    expect(result.missing).toContain("bot_create");
  });

  it("Reactions are optional", () => {
    const react = getCapabilityById("reactions")!;
    expect(react).toBeDefined();
    expect(react.optional).toBe(true);
    expect(react.grantType).toBe("refresh_token");
  });

  it("Media download is optional", () => {
    const media = getCapabilityById("media_download")!;
    expect(media).toBeDefined();
    expect(media.optional).toBe(true);
  });

  it("Message read is optional", () => {
    const read = getCapabilityById("message_read")!;
    expect(read).toBeDefined();
    expect(read.optional).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope sets
// ---------------------------------------------------------------------------

describe("scope sets", () => {
  it("ALL_CAPABILITY_SCOPES contains all unique scopes", () => {
    const scopes = new Set(CLIQ_CAPABILITIES.map((c) => c.scope));
    expect(ALL_CAPABILITY_SCOPES.length).toBe(scopes.size);
    for (const scope of scopes) {
      expect(ALL_CAPABILITY_SCOPES).toContain(scope);
    }
  });

  it("RUNTIME_REQUIRED_SCOPES only contains runtime non-optional scopes", () => {
    for (const scope of RUNTIME_REQUIRED_SCOPES) {
      const caps = CLIQ_CAPABILITIES.filter(
        (c) => c.scope === scope && c.profile === "runtime" && !c.optional,
      );
      expect(caps.length).toBeGreaterThan(0);
    }
  });

  it("SETUP_SCOPES contains only setup scopes", () => {
    for (const scope of SETUP_SCOPES) {
      const caps = CLIQ_CAPABILITIES.filter(
        (c) => c.scope === scope && c.profile === "setup",
      );
      expect(caps.length).toBeGreaterThan(0);
    }
  });

  it("SETUP_SCOPES includes Bots.READ, Bots.CREATE, and Bots.UPDATE", () => {
    expect(SETUP_SCOPES).toContain("ZohoCliq.Bots.READ");
    expect(SETUP_SCOPES).toContain("ZohoCliq.Bots.CREATE");
    expect(SETUP_SCOPES).toContain("ZohoCliq.Bots.UPDATE");
  });

  it("RUNTIME_REQUIRED_SCOPES does not include setup scopes", () => {
    for (const scope of SETUP_SCOPES) {
      expect(RUNTIME_REQUIRED_SCOPES).not.toContain(scope);
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical scope strings
// ---------------------------------------------------------------------------

describe("canonical scope strings", () => {
  it("RUNTIME_SCOPE_STRING contains all runtime scopes (required + optional)", () => {
    const runtimeCaps = CLIQ_CAPABILITIES.filter((c) => c.profile === "runtime");
    const runtimeScopes = new Set(runtimeCaps.map((c) => c.scope));
    for (const scope of runtimeScopes) {
      expect(RUNTIME_SCOPE_STRING).toContain(scope);
    }
  });

  it("RUNTIME_SCOPE_STRING is comma-separated with no spaces", () => {
    expect(RUNTIME_SCOPE_STRING).not.toContain(" ");
    const parts = RUNTIME_SCOPE_STRING.split(",");
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part).toMatch(/^ZohoCliq\./);
    }
  });

  it("SETUP_SCOPE_STRING contains Bots.READ, Bots.CREATE, and Bots.UPDATE", () => {
    expect(SETUP_SCOPE_STRING).toContain("ZohoCliq.Bots.READ");
    expect(SETUP_SCOPE_STRING).toContain("ZohoCliq.Bots.CREATE");
    expect(SETUP_SCOPE_STRING).toContain("ZohoCliq.Bots.UPDATE");
  });

  it("SETUP_SCOPE_STRING is comma-separated with no spaces", () => {
    expect(SETUP_SCOPE_STRING).not.toContain(" ");
  });

  it("FULL_SCOPE_STRING is the union of runtime and setup", () => {
    expect(FULL_SCOPE_STRING).toContain(RUNTIME_SCOPE_STRING);
    expect(FULL_SCOPE_STRING).toContain(SETUP_SCOPE_STRING);
  });

  it("scope strings do not contain duplicate scopes", () => {
    const runtimeParts = RUNTIME_SCOPE_STRING.split(",");
    expect(new Set(runtimeParts).size).toBe(runtimeParts.length);

    const fullParts = FULL_SCOPE_STRING.split(",");
    expect(new Set(fullParts).size).toBe(fullParts.length);
  });
});

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

describe("probeCliqCapability", () => {
  const apiBase = "https://cliq.zoho.eu";

  function mockFetch(status: number, body: string) {
    return vi.fn().mockResolvedValue({
      status,
      text: () => Promise.resolve(body),
    });
  }

  it("returns ok on 2xx", async () => {
    const cap = getCapabilityById("user_lookup")!;
    const fetchImpl = mockFetch(200, '{"users":[]}');
    const result = await probeCliqCapability(cap, apiBase, "token", fetchImpl);
    expect(result.status).toBe("ok");
    expect(result.capabilityId).toBe("user_lookup");
    expect(result.httpStatus).toBe(200);
  });

  it("returns missing_scope on 401 with oauthtoken_scope_invalid", async () => {
    const cap = getCapabilityById("user_lookup")!;
    const fetchImpl = mockFetch(
      401,
      '{"code":"oauthtoken_scope_invalid","message":"The OAuth token passed does not have the required scope."}',
    );
    const result = await probeCliqCapability(cap, apiBase, "token", fetchImpl);
    expect(result.status).toBe("missing_scope");
    expect(result.error).toContain("ZohoCliq.Users.READ");
  });

  it("returns missing_scope on 403 with oauthtoken_scope_invalid", async () => {
    const cap = getCapabilityById("channel_lookup")!;
    const fetchImpl = mockFetch(
      403,
      '{"code":"oauthtoken_scope_invalid"}',
    );
    const result = await probeCliqCapability(cap, apiBase, "token", fetchImpl);
    expect(result.status).toBe("missing_scope");
  });

  it("returns probe_error on other non-2xx", async () => {
    const cap = getCapabilityById("user_lookup")!;
    const fetchImpl = mockFetch(500, "Internal Server Error");
    const result = await probeCliqCapability(cap, apiBase, "token", fetchImpl);
    expect(result.status).toBe("probe_error");
    expect(result.httpStatus).toBe(500);
  });

  it("returns probe_error on 401 without oauthtoken_scope_invalid", async () => {
    const cap = getCapabilityById("user_lookup")!;
    const fetchImpl = mockFetch(401, '{"code":"invalid_token"}');
    const result = await probeCliqCapability(cap, apiBase, "token", fetchImpl);
    expect(result.status).toBe("probe_error");
  });

  it("reports unprobeable — not probe_error — when no safe probe exists", async () => {
    // "We cannot look" must stay distinguishable from "we looked and it
    // broke": only the latter is a reason to retry.
    const cap = getCapabilityById("dm_send")!;
    const fetchImpl = mockFetch(200, "{}");
    const result = await probeCliqCapability(cap, apiBase, "token", fetchImpl);
    expect(result.status).toBe("unprobeable");
    expect(result.error).toBe(cap.unprobeableReason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns probe_error on network error", async () => {
    const cap = getCapabilityById("user_lookup")!;
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await probeCliqCapability(cap, apiBase, "token", fetchImpl);
    expect(result.status).toBe("probe_error");
    expect(result.error).toContain("Network error");
  });

  it("uses the correct probe URL", async () => {
    const cap = getCapabilityById("user_lookup")!;
    const fetchImpl = mockFetch(200, "{}");
    await probeCliqCapability(cap, apiBase, "my-token", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cliq.zoho.eu/api/v2/users?limit=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Zoho-oauthtoken my-token",
        }),
      }),
    );
  });

  it("uses the correct probe URL for channel lookup", async () => {
    const cap = getCapabilityById("channel_lookup")!;
    const fetchImpl = mockFetch(200, "{}");
    await probeCliqCapability(cap, apiBase, "my-token", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cliq.zoho.eu/api/v2/channels?limit=1",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Capability report formatting
// ---------------------------------------------------------------------------

describe("formatCapabilityReport", () => {
  it("formats a report with all capabilities available", () => {
    const report: CliqCapabilityReport = {
      timestamp: "2026-01-01T00:00:00Z",
      accountId: "default",
      results: [
        { capabilityId: "dm_send", scope: "ZohoCliq.Webhooks.CREATE", status: "ok" },
        { capabilityId: "channel_send", scope: "ZohoCliq.Channels.UPDATE", status: "ok" },
        { capabilityId: "message_edit", scope: "ZohoCliq.Messages.UPDATE", status: "ok" },
        { capabilityId: "user_lookup", scope: "ZohoCliq.Users.READ", status: "ok" },
        { capabilityId: "channel_lookup", scope: "ZohoCliq.Channels.READ", status: "ok" },
      ],
      available: ["dm_send", "channel_send", "message_edit", "user_lookup", "channel_lookup"],
      missing: [],
      unprobed: [],
      summary: [],
    };
    const lines = formatCapabilityReport(report);
    expect(lines.some((l) => l.includes("✓"))).toBe(true);
    expect(lines.some((l) => l.includes("✗"))).toBe(false);
  });

  it("formats a report with missing capabilities and hints", () => {
    const report: CliqCapabilityReport = {
      timestamp: "2026-01-01T00:00:00Z",
      accountId: "default",
      results: [
        { capabilityId: "dm_send", scope: "ZohoCliq.Webhooks.CREATE", status: "ok" },
        {
          capabilityId: "channel_send",
          scope: "ZohoCliq.Channels.UPDATE",
          status: "missing_scope",
          error: "Channel @mention replies require the ZohoCliq.Channels.UPDATE scope.",
        },
      ],
      available: ["dm_send"],
      missing: ["channel_send"],
      unprobed: [],
      summary: [],
    };
    const lines = formatCapabilityReport(report);
    expect(lines.some((l) => l.includes("✗"))).toBe(true);
    expect(lines.some((l) => l.includes("ZohoCliq.Channels.UPDATE"))).toBe(true);
    expect(lines.some((l) => l.includes("Missing capabilities"))).toBe(true);
  });

  it("reports optional capabilities as degraded, not broken", () => {
    const report: CliqCapabilityReport = {
      timestamp: "2026-01-01T00:00:00Z",
      accountId: "default",
      results: [
        { capabilityId: "dm_send", scope: "ZohoCliq.Webhooks.CREATE", status: "ok" },
        {
          capabilityId: "reactions",
          scope: "ZohoCliq.messageactions.CREATE",
          status: "missing_scope",
          error: "Reactions require the ZohoCliq.messageactions.CREATE scope.",
        },
      ],
      available: ["dm_send"],
      missing: ["reactions"],
      unprobed: [],
      summary: [],
    };
    const lines = formatCapabilityReport(report);
    // Optional capabilities are in the "optional" section
    const optionalSection = lines.findIndex((l) =>
      l.includes("optional — degrades features"),
    );
    expect(optionalSection).toBeGreaterThan(0);
    // The missing reactions capability should be under the optional section
    const reactionsLine = lines.find(
      (l, i) => i > optionalSection && l.includes("reactions"),
    );
    expect(reactionsLine).toBeDefined();
  });

  it("includes setup/maintenance section", () => {
    const report: CliqCapabilityReport = {
      timestamp: "2026-01-01T00:00:00Z",
      accountId: "default",
      results: [
        { capabilityId: "bot_read", scope: "ZohoCliq.Bots.READ", status: "ok" },
        { capabilityId: "bot_update", scope: "ZohoCliq.Bots.UPDATE", status: "missing_scope", error: "Bot update requires ZohoCliq.Bots.UPDATE." },
      ],
      available: ["bot_read"],
      missing: ["bot_update"],
      unprobed: [],
      summary: [],
    };
    const lines = formatCapabilityReport(report);
    expect(lines.some((l) => l.includes("Setup / maintenance"))).toBe(true);
    expect(lines.some((l) => l.includes("ZohoCliq.Bots.READ"))).toBe(true);
    expect(lines.some((l) => l.includes("ZohoCliq.Bots.UPDATE"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

describe("getCapabilityById", () => {
  it("finds an existing capability", () => {
    const cap = getCapabilityById("dm_send");
    expect(cap).toBeDefined();
    expect(cap!.scope).toBe("ZohoCliq.Webhooks.CREATE");
  });

  it("returns undefined for unknown id", () => {
    expect(getCapabilityById("nonexistent")).toBeUndefined();
  });
});

describe("getCapabilitiesByProfile", () => {
  it("returns only runtime capabilities", () => {
    const runtime = getCapabilitiesByProfile("runtime");
    for (const cap of runtime) {
      expect(cap.profile).toBe("runtime");
    }
    expect(runtime.length).toBeGreaterThan(0);
  });

  it("returns only setup capabilities", () => {
    const setup = getCapabilitiesByProfile("setup");
    for (const cap of setup) {
      expect(cap.profile).toBe("setup");
    }
    expect(setup.length).toBeGreaterThan(0);
  });

  it("filters by optional flag", () => {
    const optionalRuntime = getCapabilitiesByProfile("runtime", true);
    for (const cap of optionalRuntime) {
      expect(cap.optional).toBe(true);
    }
    const requiredRuntime = getCapabilitiesByProfile("runtime", false);
    for (const cap of requiredRuntime) {
      expect(cap.optional).toBe(false);
    }
  });
});

describe("getRequiredScopesForProfile", () => {
  it("returns required runtime scopes", () => {
    const scopes = getRequiredScopesForProfile("runtime");
    expect(scopes).toContain("ZohoCliq.Webhooks.CREATE");
    expect(scopes).toContain("ZohoCliq.Channels.UPDATE");
    expect(scopes).toContain("ZohoCliq.Messages.UPDATE");
    expect(scopes).toContain("ZohoCliq.Users.READ");
    expect(scopes).toContain("ZohoCliq.Channels.READ");
    // Optional scopes should NOT be included
    expect(scopes).not.toContain("ZohoCliq.messageactions.CREATE");
    expect(scopes).not.toContain("ZohoCliq.Attachments.READ");
  });

  it("returns required setup scopes", () => {
    const scopes = getRequiredScopesForProfile("setup");
    expect(scopes).toContain("ZohoCliq.Bots.READ");
    expect(scopes).toContain("ZohoCliq.Bots.CREATE");
    expect(scopes).toContain("ZohoCliq.Bots.UPDATE");
  });

  it("returns no duplicates", () => {
    const runtime = getRequiredScopesForProfile("runtime");
    expect(new Set(runtime).size).toBe(runtime.length);
    const setup = getRequiredScopesForProfile("setup");
    expect(new Set(setup).size).toBe(setup.length);
  });
});

// ---------------------------------------------------------------------------
// Grant type requirements
// ---------------------------------------------------------------------------

describe("grant type requirements", () => {
  it("client_credentials scopes are for DM and directory operations", () => {
    const ccCaps = CLIQ_CAPABILITIES.filter((c) => c.grantType === "client_credentials");
    for (const cap of ccCaps) {
      expect(["ZohoCliq.Webhooks.CREATE", "ZohoCliq.Users.READ", "ZohoCliq.Channels.READ", "ZohoCliq.Bots.READ", "ZohoCliq.Bots.CREATE", "ZohoCliq.Bots.UPDATE"]).toContain(cap.scope);
    }
  });

  it("refresh_token scopes are for user-context operations", () => {
    const rtCaps = CLIQ_CAPABILITIES.filter((c) => c.grantType === "refresh_token");
    for (const cap of rtCaps) {
      expect(cap.scope).not.toBe("ZohoCliq.Webhooks.CREATE");
      expect(cap.scope).not.toBe("ZohoCliq.Users.READ");
      expect(cap.scope).not.toBe("ZohoCliq.Channels.READ");
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: misleading scope text must never become capability proof
// ---------------------------------------------------------------------------

describe("capability honesty invariants (issue #93)", () => {
  it("never reports a capability without a probe path as probed-ok or probe-error", async () => {
    const fetchImpl = vi.fn();
    for (const capability of CLIQ_CAPABILITIES.filter((entry) => !entry.probePath)) {
      const result = await probeCliqCapability(
        capability,
        "https://cliq.zoho.eu",
        "token",
        fetchImpl as unknown as typeof fetch,
      );
      expect(result.status).not.toBe("ok");
      expect(result.status).not.toBe("probe_error");
      expect(["unprobeable", "scope_reported_only"]).toContain(result.status);
    }
    // "No safe probe exists" must never cost a network call.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("states an explicit reason for every capability that has no safe probe", () => {
    for (const capability of CLIQ_CAPABILITIES.filter((entry) => !entry.probePath)) {
      expect(capability.unprobeableReason, capability.id).toBeTruthy();
      expect(capability.unprobeableReason!.length).toBeGreaterThan(10);
    }
  });

  it("only ever probes with read-only GET requests", () => {
    for (const capability of CLIQ_CAPABILITIES.filter((entry) => entry.probePath)) {
      expect(capability.probeMethod, capability.id).toBe("GET");
      expect(capability.probePath!, capability.id).toMatch(/^\/api\/v[23]\//);
      expect(capability.probePath!, capability.id).not.toMatch(
        /\/(messages|handlers|reactions)(\/|$|\?)/,
      );
    }
  });

  it("reports bot_create from consent only and never contacts the API for it", async () => {
    const fetchImpl = vi.fn();
    const botCreate = getCapabilityById("bot_create")!;
    const result = await probeCliqCapability(
      botCreate,
      "https://cliq.zoho.eu",
      "token",
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.status).toBe("scope_reported_only");
    expect(result.httpStatus).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not let a token that echoes every scope pass when the API rejects it", async () => {
    // The Zoho failure mode from learning 070: the token response reports the
    // scope, the API still answers oauthtoken_scope_invalid.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: "oauthtoken_scope_invalid" }), { status: 401 }),
    );
    const probeable = CLIQ_CAPABILITIES.filter((entry) => entry.probePath);
    expect(probeable.length).toBeGreaterThan(0);
    for (const capability of probeable) {
      const result = await probeCliqCapability(
        capability,
        "https://cliq.zoho.eu",
        "token",
        fetchImpl as unknown as typeof fetch,
      );
      expect(result.status, capability.id).toBe("missing_scope");
    }
    // And the granted-scope evaluation alone must not claim those capabilities work.
    const evaluation = evaluateCliqScopeSet(FULL_SCOPE_STRING);
    expect(evaluation.granted.length).toBeGreaterThan(0);
    expect(evaluation.scopeReportedOnly).toContain("bot_create");
  });

  it("treats a legacy two-scope consent as missing every other capability", () => {
    const evaluation = evaluateCliqScopeSet(
      "ZohoCliq.Webhooks.CREATE,ZohoCliq.Channels.UPDATE",
    );
    expect(evaluation.available).toContain("dm_send");
    expect(evaluation.missing).toContain("bot_read");
    expect(evaluation.missing).toContain("bot_create");
    expect(evaluation.canInspectBots).toBe(false);
    expect(evaluation.canCreateBots).toBe(false);
  });

  it("keeps refresh-token capabilities distinct from client-credentials ones", () => {
    const clientCredentialsOnly = CLIQ_CAPABILITIES
      .filter((entry) => entry.grantType === "client_credentials")
      .map((entry) => entry.scope);
    const evaluation = evaluateCliqScopeSet(clientCredentialsOnly);
    for (const capability of CLIQ_CAPABILITIES.filter(
      (entry) => entry.grantType === "refresh_token",
    )) {
      expect(evaluation.missing, capability.id).toContain(capability.id);
    }
    expect(evaluation.available).toContain("dm_send");
  });

  it("does not mark a complete consent as proof that bot creation works", () => {
    const evaluation = evaluateCliqScopeSet(FULL_SCOPE_STRING);
    expect(evaluation.missing).toEqual([]);
    expect(evaluation.scopeReportedOnly).toContain("bot_create");
  });
});
