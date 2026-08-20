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
 *    message edit/streaming, reactions, media download.
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
  // ── Setup / Maintenance ───────────────────────────────────────────────
  {
    id: "bot_read",
    label: "Bot read",
    scope: "ZohoCliq.Bots.READ",
    grantType: "client_credentials",
    profile: "setup",
    category: "setup",
    optional: false,
    probePath: null,
    probeMethod: "GET",
    missingHint:
      "Bot inspection requires the ZohoCliq.Bots.READ scope. Re-consent your self-client with this scope and regenerate the token.",
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
  "ZohoCliq.Webhooks.CREATE",
  "ZohoCliq.Channels.UPDATE",
  "ZohoCliq.Channels.CREATE",
  "ZohoCliq.Channels.READ",
  "ZohoCliq.Users.READ",
  "ZohoCliq.Messages.UPDATE",
  "ZohoCliq.Messages.READ",
  "ZohoCliq.Messages.DELETE",
  "ZohoCliq.messageactions.CREATE",
  "ZohoCliq.Attachments.READ",
].join(",");

/**
 * Canonical comma-separated scope string for the **setup/maintenance**
 * profile — bot read + bot update. Added alongside the runtime scopes when
 * the operator also needs handler provisioning from `openclaw setup`.
 */
export const SETUP_SCOPE_STRING = [
  "ZohoCliq.Bots.READ",
  "ZohoCliq.Bots.UPDATE",
].join(",");

/**
 * Combined scope string (runtime + setup) for a single consent that covers
 * everything.
 */
export const FULL_SCOPE_STRING = [
  RUNTIME_SCOPE_STRING,
  SETUP_SCOPE_STRING,
].join(",");

// ---------------------------------------------------------------------------
// Probe result types
// ---------------------------------------------------------------------------

export type CliqProbeStatus = "ok" | "missing_scope" | "probe_error";

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
  if (!capability.probePath) {
    return {
      capabilityId: capability.id,
      scope: capability.scope,
      status: "probe_error",
      error: "No probe path defined for this capability.",
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
    const status = result?.status ?? "unprobed";
    const icon = status === "ok" ? "✓" : status === "missing_scope" ? "✗" : "?";
    const grantLabel = cap.grantType === "client_credentials" ? "client_credentials" : "refresh_token";
    lines.push(`  ${icon} ${cap.label} — ${cap.scope} (${grantLabel})`);
    if (status === "missing_scope" && result?.error) {
      lines.push(`    → ${result.error}`);
    }
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
    const status = result?.status ?? "unprobed";
    const icon = status === "ok" ? "✓" : status === "missing_scope" ? "✗" : "?";
    const grantLabel = cap.grantType === "client_credentials" ? "client_credentials" : "refresh_token";
    lines.push(`  ${icon} ${cap.label} — ${cap.scope} (${grantLabel})`);
    if (status === "missing_scope" && result?.error) {
      lines.push(`    → ${result.error}`);
    }
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
    const status = result?.status ?? "unprobed";
    const icon = status === "ok" ? "✓" : status === "missing_scope" ? "✗" : "?";
    const grantLabel = cap.grantType === "client_credentials" ? "client_credentials" : "refresh_token";
    lines.push(`  ${icon} ${cap.label} — ${cap.scope} (${grantLabel})`);
    if (status === "missing_scope" && result?.error) {
      lines.push(`    → ${result.error}`);
    }
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
