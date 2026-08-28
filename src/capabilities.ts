/**
 * Centralized OAuth capability matrix for the Zoho Cliq channel plugin.
 *
 * Every capability the plugin needs is declared here — its scope, grant type,
 * whether it is required for runtime messaging or only for setup/maintenance,
 * and a non-destructive API probe that validates the token actually carries
 * the scope (rather than trusting the configured scope string).
 *
 * Profiles (canonical scope strings for README + setup):
 *  - **Runtime** — DM send, channel send, user lookup, channel lookup,
 *    message edit/streaming, native chat typing, reactions, media download.
 *  - **Setup/Maintenance** — bot read, bot update, handler provisioning.
 *
 * The matrix is the single source of truth for code, doctor, setup, and docs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which OAuth grant type can mint a usable token for this scope. */
export type CliqGrantType = "client_credentials" | "refresh_token";

/**
 * Category grouping for the capability report.
 * - `"messaging"` — core send/receive (DM + channel).
 * - `"rich"` — optional rich features (reactions, media, streaming).
 * - `"directory"` — user/channel lookup.
 * - `"setup"` — bot/handler inspection and provisioning (setup/maintenance only).
 */
export type CliqCapabilityCategory = "messaging" | "rich" | "directory" | "setup";

/** A single entry in the capability matrix. */
export interface CliqCapability {
  /** Stable machine id (e.g. `"dm_send"`, `"channel_send"`). */
  readonly id: string;
  /** Human label for the capability report (e.g. "DM send", "Channel send"). */
  readonly label: string;
  /** The OAuth scope required for this capability. */
  readonly scope: string;
  /**
   * Which grant type(s) can produce a usable token for this scope.
   * `client_credentials` scopes are automatically available; `refresh_token`
   * scopes require the one-time self-client authorization_code flow.
   */
  readonly grantType: CliqGrantType;
  /**
   * Whether this capability is required at runtime (normal messaging) or
   * only during setup/maintenance (bot/handler provisioning).
   */
  readonly profile: "runtime" | "setup";
  /**
   * Functional category for grouped reporting.
   */
  readonly category: CliqCapabilityCategory;
  /**
   * Whether this capability is optional — missing an optional capability
   * degrades a feature (e.g. reactions, media) rather than breaking core
   * messaging.
   */
  readonly optional: boolean;
  /**
   * Non-destructive API probe path (relative to apiBase) that validates the
   * token actually carries this scope. A GET that returns 2xx = capable;
   * 401/403 with `oauthtoken_scope_invalid` = scope missing from the token.
   * `null` means no safe probe exists (trust the configured scope).
   */
  readonly probePath: string | null;
  /**
   * HTTP method for the probe. GET is preferred (non-destructive); POST is
   * used only when no GET endpoint exists for the scope.
   */
  readonly probeMethod: "GET" | "POST";
  /**
   * Human-readable hint shown when the probe fails — tells the operator
   * which scope is missing and how to regenerate the token.
   */
  readonly missingHint: string;
  /**
   * Why no safe probe exists, for every capability with `probePath: null`.
   *
   * Required so that "we cannot look" is always a stated, reviewable fact
   * rather than an omission — and so a future contributor cannot quietly
   * bolt on a destructive probe (a real send, a live `PATCH`, a bot
   * creation) to make an honest gap look green.
   */
  readonly unprobeableReason?: string;
  /**
   * The capability is reported from the granted scope set only. Zoho issues
   * tokens that echo a scope the API later rejects (learning 070), so this
   * is explicitly weaker than a probe and must never be rendered as proof.
   */
  readonly scopeReportedOnly?: boolean;
}

// ---------------------------------------------------------------------------
// The capability matrix
// ---------------------------------------------------------------------------

/**
 * All capabilities the Zoho Cliq plugin can use. The matrix is the single
 * source of truth — doctor, setup, inspect, and tests all read from here.
 */
export const CLIQ_CAPABILITIES: readonly CliqCapability[] = [
  // ── Runtime: Messaging ────────────────────────────────────────────────
  {
    id: "dm_send",
    label: "DM send",
    scope: "ZohoCliq.Webhooks.CREATE",
    grantType: "client_credentials",
    profile: "runtime",
    category: "messaging",
    optional: false,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is posting a real DM, which would deliver a visible message; the read-only doctor stage must not send. Use --outbound-test to exercise it deliberately.",
    missingHint:
      "Bot DMs require the ZohoCliq.Webhooks.CREATE scope. Re-consent your self-client with this scope and regenerate the token.",
  },
  {
    id: "channel_send",
    label: "Channel send",
    scope: "ZohoCliq.Channels.UPDATE",
    grantType: "refresh_token",
    profile: "runtime",
    category: "messaging",
    optional: false,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is posting a real channel message, which would be visible to the channel; the read-only doctor stage must not send. Use --outbound-test to exercise it deliberately.",
    missingHint:
      "Channel @mention replies require the ZohoCliq.Channels.UPDATE scope on a user-context refresh token. Re-consent with this scope and re-run the authorization_code exchange (see README §3c).",
  },
  {
    id: "message_edit",
    label: "Message edit / streaming",
    scope: "ZohoCliq.Messages.UPDATE",
    grantType: "refresh_token",
    profile: "runtime",
    category: "messaging",
    optional: false,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is editing a real message, which requires an existing message id and mutates it. Exercised by the streaming/outbound send stage instead.",
    missingHint:
      "Live-edit streaming previews require the ZohoCliq.Messages.UPDATE scope on a user-context refresh token. Re-consent with this scope and re-run the authorization_code exchange (see README §3c).",
  },
  // ── Runtime: Rich features (optional) ─────────────────────────────────
  {
    id: "reactions",
    label: "Message reactions",
    scope: "ZohoCliq.messageactions.CREATE",
    grantType: "refresh_token",
    profile: "runtime",
    category: "rich",
    optional: true,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is adding a real reaction to an existing message, which mutates that message.",
    missingHint:
      "Reactions require the ZohoCliq.messageactions.CREATE scope on a user-context refresh token. The react action will be unavailable until you re-consent with this scope.",
  },
  {
    id: "media_download",
    label: "Inbound media download",
    scope: "ZohoCliq.Attachments.READ",
    grantType: "refresh_token",
    profile: "runtime",
    category: "rich",
    optional: true,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is downloading a real attachment, which requires a file id that only arrives with live inbound media.",
    missingHint:
      "Inbound file/image/voice download requires the ZohoCliq.Attachments.READ scope on a user-context refresh token. Inbound media will degrade to name-only until you re-consent.",
  },
  {
    id: "message_read",
    label: "Message read (file-id resolution, quote fetch)",
    scope: "ZohoCliq.Messages.READ",
    grantType: "refresh_token",
    profile: "runtime",
    category: "rich",
    optional: true,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "Zoho exposes no organization-wide message list; reading requires a concrete chat and message id that only exist for live traffic.",
    missingHint:
      "Resolving inbound attachment file ids and fetching quoted message text requires the ZohoCliq.Messages.READ scope on a user-context refresh token. Inbound images degrade to name-only without it.",
  },
  {
    id: "message_delete",
    label: "Message delete (v3)",
    scope: "ZohoCliq.Messages.DELETE",
    grantType: "refresh_token",
    profile: "runtime",
    category: "rich",
    optional: true,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is deleting a real message, which is destructive and irreversible.",
    missingHint:
      "The v3 message-delete endpoint requires the ZohoCliq.Messages.DELETE scope on a user-context refresh token. Only needed when apiVersion.delete is 'v3'.",
  },
  {
    id: "channel_card_v3",
    label: "Channel card (v3 Message Card)",
    scope: "ZohoCliq.Channels.CREATE",
    grantType: "refresh_token",
    profile: "runtime",
    category: "rich",
    optional: true,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is posting a real card to a channel, which would be visible to the channel.",
    missingHint:
      "The v3 channel-card endpoint requires the ZohoCliq.Channels.CREATE scope on a user-context refresh token. Only needed when apiVersion.channelCard is 'v3'.",
  },
  // ── Runtime: Directory ────────────────────────────────────────────────
  {
    id: "user_lookup",
    label: "User lookup",
    scope: "ZohoCliq.Users.READ",
    grantType: "client_credentials",
    profile: "runtime",
    category: "directory",
    optional: false,
    probePath: "/api/v2/users?limit=1",
    probeMethod: "GET",
    missingHint:
      "User directory lookup requires the ZohoCliq.Users.READ scope. Re-consent your self-client with this scope and regenerate the token.",
  },
  {
    id: "channel_lookup",
    label: "Channel lookup",
    scope: "ZohoCliq.Channels.READ",
    grantType: "client_credentials",
    profile: "runtime",
    category: "directory",
    optional: false,
    probePath: "/api/v2/channels?limit=1",
    probeMethod: "GET",
    missingHint:
      "Channel directory lookup requires the ZohoCliq.Channels.READ scope. Re-consent your self-client with this scope and regenerate the token.",
  },
  {
    id: "chat_typing",
    label: "Native chat typing (v3 activities)",
    scope: "ZohoCliq.Chats.UPDATE",
    // Operators consent this on the Self Client refresh-token string. The
    // client_credentials grant can mint a token that reports the scope and a
    // live POST /api/v3/chats/{chat_id}/activities {"action":"typing"} 204
    // has been observed with that grant, but listing chats is a different
    // capability (GET /api/v2/chats still returns oauthtoken_scope_invalid).
    grantType: "refresh_token",
    profile: "runtime",
    category: "rich",
    optional: false,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is POST /api/v3/chats/{chat_id}/activities with action typing, which is a live side effect (rate-limited at 100 req/min/user; exceeding can lock for up to 50 minutes). Doctor must not fire activities.",
    missingHint:
      "Native v3 chat typing requires the ZohoCliq.Chats.UPDATE scope on a user-context refresh token. Re-consent your Self Client including this scope and regenerate the refresh token (see README §3c). client_credentials can mint a token that reports the scope, but operators still consent it on the Self Client string. Previously consented tokens without this scope fail typing with oauthtoken_scope_invalid.",
  },
  // ── Setup / Maintenance ───────────────────────────────────────────────
  {
    id: "bot_read",
    label: "Bot read",
    scope: "ZohoCliq.Bots.READ",
    grantType: "client_credentials",
    profile: "setup",
    category: "setup",
    optional: false,
    // The same read the client already performs for bot inspection, capped
    // at a single record. Purely non-destructive, and the gate every other
    // provisioning step depends on — so it is worth proving rather than
    // assuming.
    probePath: "/api/v3/bots?limit=1",
    probeMethod: "GET",
    missingHint:
      "Bot inspection requires the ZohoCliq.Bots.READ scope. Re-consent your self-client with this scope and regenerate the token.",
  },
  {
    id: "bot_create",
    label: "Bot create",
    scope: "ZohoCliq.Bots.CREATE",
    grantType: "client_credentials",
    profile: "setup",
    category: "setup",
    optional: false,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is POST /api/v3/bots, which would create a real bot in the organization; reported from the granted scope set instead.",
    missingHint:
      "Creating a bot requires the ZohoCliq.Bots.CREATE scope. A token with only Bots.READ and Bots.UPDATE can inspect and update existing bots but POST /api/v3/bots will fail. Re-consent your self-client with ZohoCliq.Bots.CREATE and regenerate the token.",
    scopeReportedOnly: true,
  },
  {
    id: "bot_update",
    label: "Bot / handler update",
    scope: "ZohoCliq.Bots.UPDATE",
    grantType: "client_credentials",
    profile: "setup",
    category: "setup",
    optional: false,
    probePath: null,
    probeMethod: "GET",
    unprobeableReason:
      "the only proof is a PATCH of a live handler script, which would overwrite Zoho-held code that real inbound delivery depends on.",
    missingHint:
      "Bot and handler provisioning requires the ZohoCliq.Bots.UPDATE scope. Re-consent your self-client with this scope and regenerate the token.",
  },
] as const;

// ---------------------------------------------------------------------------
// Scope sets derived from the matrix
// ---------------------------------------------------------------------------

/** All unique scopes referenced by the matrix. */
export const ALL_CAPABILITY_SCOPES: readonly string[] = [
  ...new Set(CLIQ_CAPABILITIES.map((c) => c.scope)),
];

/** Scopes required for runtime (non-optional runtime capabilities). */
export const RUNTIME_REQUIRED_SCOPES: readonly string[] = [
  ...new Set(
    CLIQ_CAPABILITIES
      .filter((c) => c.profile === "runtime" && !c.optional)
      .map((c) => c.scope),
  ),
];

/** Scopes required for setup/maintenance. */
export const SETUP_SCOPES: readonly string[] = [
  ...new Set(
    CLIQ_CAPABILITIES
      .filter((c) => c.profile === "setup")
      .map((c) => c.scope),
  ),
];

/**
 * Canonical comma-separated scope string for the **runtime** profile
 * (copy-paste into the Zoho API Console's Generate Code scope field).
 *
 * Includes all runtime scopes — required + optional — so a single consent
 * covers every feature. Operators who do not need optional features (reactions,
 * media, streaming) can trim the list, but the canonical string is the
 * superset.
 */
export const RUNTIME_SCOPE_STRING = [
  ...new Set(
    CLIQ_CAPABILITIES
      .filter((capability) => capability.profile === "runtime")
      .map((capability) => capability.scope),
  ),
].join(",");

/**
 * Canonical comma-separated scope string for the **setup/maintenance**
 * profile — inspect existing bots. Add `SETUP_PROVISION_SCOPE_STRING` to
 * create new bots and configure their handlers from `openclaw setup`.
 */
export const SETUP_INSPECT_SCOPE_STRING = "ZohoCliq.Bots.READ";

/** Setup profile for bot creation and handler provisioning. */
export const SETUP_PROVISION_SCOPE_STRING = [
  "ZohoCliq.Bots.READ",
  "ZohoCliq.Bots.CREATE",
  "ZohoCliq.Bots.UPDATE",
].join(",");

/** Backward-compatible setup alias for the complete provisioning profile. */
export const SETUP_SCOPE_STRING = SETUP_PROVISION_SCOPE_STRING;

/**
 * Combined scope string (runtime + setup) for a single consent that covers
 * everything.
 */
export const FULL_SCOPE_STRING = [
  RUNTIME_SCOPE_STRING,
  SETUP_SCOPE_STRING,
].join(",");

export interface CliqScopeSetEvaluation {
  readonly granted: readonly string[];
  readonly available: readonly string[];
  readonly missing: readonly string[];
  readonly scopeReportedOnly: readonly string[];
  readonly messages: readonly string[];
  readonly canInspectBots: boolean;
  readonly canCreateBots: boolean;
}

export function evaluateCliqScopeSet(
  grantedScopes: string | readonly string[],
): CliqScopeSetEvaluation {
  const rawScopes = typeof grantedScopes === "string"
    ? grantedScopes.split(",")
    : grantedScopes;
  const granted = [...new Set(rawScopes.map((scope) => scope.trim()).filter(Boolean))];
  const grantedSet = new Set(granted);
  const available = CLIQ_CAPABILITIES
    .filter((capability) => grantedSet.has(capability.scope))
    .map((capability) => capability.id);
  const missingCapabilities = CLIQ_CAPABILITIES.filter(
    (capability) => !grantedSet.has(capability.scope),
  );
  const scopeReportedOnly = CLIQ_CAPABILITIES
    .filter(
      (capability) => capability.scopeReportedOnly && grantedSet.has(capability.scope),
    )
    .map((capability) => capability.id);

  return {
    granted,
    available,
    missing: missingCapabilities.map((capability) => capability.id),
    scopeReportedOnly,
    messages: missingCapabilities.map((capability) => capability.missingHint),
    canInspectBots: grantedSet.has("ZohoCliq.Bots.READ"),
    canCreateBots: grantedSet.has("ZohoCliq.Bots.CREATE"),
  };
}

// ---------------------------------------------------------------------------
// Probe result types
// ---------------------------------------------------------------------------

/**
 * Outcome of a capability check.
 *
 * `unprobeable` and `scope_reported_only` exist so that "we could not look"
 * is never conflated with "we looked and it broke" (`probe_error`), and
 * neither is ever conflated with proof (`ok`).
 */
export type CliqProbeStatus =
  | "ok"
  | "missing_scope"
  | "probe_error"
  | "unprobeable"
  | "scope_reported_only";

export interface CliqCapabilityProbeResult {
  readonly capabilityId: string;
  readonly scope: string;
  readonly status: CliqProbeStatus;
  /** HTTP status from the probe, if a probe was executed. */
  readonly httpStatus?: number;
  /** Error message when status is `"probe_error"` or `"missing_scope"`. */
  readonly error?: string;
}

export interface CliqCapabilityReport {
  /** Timestamp of the report. */
  readonly timestamp: string;
  /** Account id the report was generated for. */
  readonly accountId: string;
  /** Per-capability probe results (only probed capabilities). */
  readonly results: readonly CliqCapabilityProbeResult[];
  /** Capabilities confirmed available (probed ok). */
  readonly available: readonly string[];
  /** Capabilities confirmed missing (probed and scope rejected). */
  readonly missing: readonly string[];
  /** Capabilities that could not be probed (no probe path, or probe error). */
  readonly unprobed: readonly string[];
  /**
   * Capabilities with no safe read-only probe. Distinct from `unprobed`:
   * these are known to be unverifiable by design, not merely unattempted.
   */
  readonly unprobeable?: readonly string[];
  /**
   * Capabilities reported from the granted scope set only. Weaker than a
   * probe and never proof (learning 070).
   */
  readonly scopeReportedOnly?: readonly string[];
  /** Human-readable summary lines. */
  readonly summary: readonly string[];
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

/**
 * Build the headers for an API probe request. Uses the access token
 * directly (the caller resolves which grant to use).
 */
function probeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Zoho-oauthtoken ${token}`,
  };
}

/**
 * Run a single non-destructive API probe for a capability. Returns the
 * probe result. The caller must supply the access token (from either
 * `client_credentials` or `refresh_token` grant, depending on the
 * capability's `grantType`).
 *
 * The probe is non-destructive: GET requests never modify state. POST
 * probes (only when no GET endpoint exists) send an empty body.
 *
 * A 2xx response means the token carries the scope. A 401 or 403 with
 * `oauthtoken_scope_invalid` in the body means the scope is missing from
 * the token. Any other error is a probe error (network, timeout, etc.)
 * and is reported as `"probe_error"` rather than `"missing_scope"`.
 */
export async function probeCliqCapability(
  capability: CliqCapability,
  apiBase: string,
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CliqCapabilityProbeResult> {
  if (capability.scopeReportedOnly) {
    // Deliberately no request: the only proof would be destructive. Zoho
    // also echoes scopes it later rejects (learning 070), so consent is
    // reported as strictly weaker evidence than a probe.
    return {
      capabilityId: capability.id,
      scope: capability.scope,
      status: "scope_reported_only",
      error:
        capability.unprobeableReason ??
        "Reported from the granted scope set, not proven by an API call.",
    };
  }
  if (!capability.probePath) {
    return {
      capabilityId: capability.id,
      scope: capability.scope,
      status: "unprobeable",
      error:
        capability.unprobeableReason ??
        "No safe read-only probe exists for this capability.",
    };
  }

  const url = `${apiBase}${capability.probePath}`;
  try {
    const res = await fetchImpl(url, {
      method: capability.probeMethod,
      headers: probeHeaders(token),
    });

    if (res.status >= 200 && res.status < 300) {
      return {
        capabilityId: capability.id,
        scope: capability.scope,
        status: "ok",
        httpStatus: res.status,
      };
    }

    const body = await res.text().catch(() => "");

    // Check for scope-invalid error — the definitive signal that the token
    // does not carry this scope.
    if (
      (res.status === 401 || res.status === 403) &&
      body.includes("oauthtoken_scope_invalid")
    ) {
      return {
        capabilityId: capability.id,
        scope: capability.scope,
        status: "missing_scope",
        httpStatus: res.status,
        error: capability.missingHint,
      };
    }

    // Any other non-2xx is a probe error (not a definitive scope failure).
    return {
      capabilityId: capability.id,
      scope: capability.scope,
      status: "probe_error",
      httpStatus: res.status,
      error: `Probe returned ${res.status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      capabilityId: capability.id,
      scope: capability.scope,
      status: "probe_error",
      error: `Probe failed: ${String(err)}`,
    };
  }
}

/**
 * Generate a human-readable capability report from probe results.
 * Organizes capabilities into runtime vs setup sections, marks missing
 * capabilities with their likely scope and regeneration instructions,
 * and reports optional features as degraded rather than broken.
 */
/**
 * Render one capability line.
 *
 * The markers are deliberately distinct: `?` (the probe ran and failed) must
 * not look like `–` (no safe probe exists) or `~` (consent-reported only).
 * Collapsing them would let an unverifiable capability read as a verdict.
 */
function describeCapabilityLine(
  cap: CliqCapability,
  result: CliqCapabilityProbeResult | undefined,
): string[] {
  const status = result?.status ?? "unprobed";
  const icon =
    status === "ok"
      ? "\u2713"
      : status === "missing_scope"
        ? "\u2717"
        : status === "unprobeable"
          ? "\u2013"
          : status === "scope_reported_only"
            ? "~"
            : "?";
  const grantLabel =
    cap.grantType === "client_credentials" ? "client_credentials" : "refresh_token";
  const lines = [`  ${icon} ${cap.label} \u2014 ${cap.scope} (${grantLabel})`];
  if (status === "missing_scope" && result?.error) {
    lines.push(`    \u2192 ${result.error}`);
  } else if (status === "unprobeable") {
    lines.push(
      `    \u2192 not verified: ${result?.error ?? cap.unprobeableReason ?? "no safe read-only probe exists"}`,
    );
  } else if (status === "scope_reported_only") {
    lines.push(
      `    \u2192 reported from the granted scope set, not proven: ${result?.error ?? cap.unprobeableReason ?? ""}`.trimEnd(),
    );
  }
  return lines;
}

export function formatCapabilityReport(report: CliqCapabilityReport): string[] {
  const lines: string[] = [];
  lines.push(`Capability report for account ${report.accountId} (${report.timestamp})`);
  lines.push("");

  // Runtime required
  const runtimeRequired = CLIQ_CAPABILITIES.filter(
    (c) => c.profile === "runtime" && !c.optional,
  );
  const runtimeRequiredResults = runtimeRequired
    .map((cap) => ({
      cap,
      result: report.results.find((r) => r.capabilityId === cap.id),
    }));

  lines.push("Runtime capabilities (required for messaging):");
  for (const { cap, result } of runtimeRequiredResults) {
    lines.push(...describeCapabilityLine(cap, result));
  }
  lines.push("");

  // Runtime optional
  const runtimeOptional = CLIQ_CAPABILITIES.filter(
    (c) => c.profile === "runtime" && c.optional,
  );
  const runtimeOptionalResults = runtimeOptional
    .map((cap) => ({
      cap,
      result: report.results.find((r) => r.capabilityId === cap.id),
    }));

  lines.push("Runtime capabilities (optional — degrades features, not messaging):");
  for (const { cap, result } of runtimeOptionalResults) {
    lines.push(...describeCapabilityLine(cap, result));
  }
  lines.push("");

  // Setup / maintenance
  const setupCaps = CLIQ_CAPABILITIES.filter((c) => c.profile === "setup");
  const setupResults = setupCaps
    .map((cap) => ({
      cap,
      result: report.results.find((r) => r.capabilityId === cap.id),
    }));

  lines.push("Setup / maintenance capabilities:");
  for (const { cap, result } of setupResults) {
    lines.push(...describeCapabilityLine(cap, result));
  }
  lines.push("");

  // Summary
  if (report.missing.length > 0) {
    lines.push(`Missing capabilities: ${report.missing.join(", ")}`);
  }
  if (report.unprobed.length > 0) {
    lines.push(`Unprobed capabilities: ${report.unprobed.join(", ")}`);
  }
  if (report.available.length > 0) {
    lines.push(`Available capabilities: ${report.available.join(", ")}`);
  }

  return lines;
}

/**
 * Look up a capability by its id. Returns `undefined` if not found.
 */
export function getCapabilityById(id: string): CliqCapability | undefined {
  return CLIQ_CAPABILITIES.find((c) => c.id === id);
}

/**
 * Get all capabilities for a given profile and optional flag filter.
 */
export function getCapabilitiesByProfile(
  profile: "runtime" | "setup",
  optionalFilter?: boolean,
): readonly CliqCapability[] {
  return CLIQ_CAPABILITIES.filter(
    (c) =>
      c.profile === profile &&
      (optionalFilter === undefined || c.optional === optionalFilter),
  );
}

/**
 * Get the required scopes for a profile (non-optional capabilities only).
 */
export function getRequiredScopesForProfile(
  profile: "runtime" | "setup",
): readonly string[] {
  return [
    ...new Set(
      CLIQ_CAPABILITIES
        .filter((c) => c.profile === profile && !c.optional)
        .map((c) => c.scope),
    ),
  ];
}
