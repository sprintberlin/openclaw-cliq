import {
  createStandardChannelSetupStatus,
  createTopLevelChannelDmPolicy,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  CLIQ_DATA_CENTERS,
  CLIQ_DEFAULT_DC_ID,
  findCliqDataCenterById,
  findCliqDataCenterByApiBase,
  findCliqDataCenterByOauthBase,
  getDefaultCliqDataCenter,
  type CliqDataCenter,
} from "./region.js";
import {
  formatCliqPreflightReport,
  runCliqWebhookPreflight,
  type CliqPreflightReport,
} from "./webhook-preflight.js";
import {
  resolveCliqInboundReadiness,
  type CliqInboundReadiness,
} from "./inbound-readiness.js";
import { resolveCliqSecretString } from "./secret-resolve.js";
import { resolveCliqDirectoryAllowlist } from "./setup-directory.js";
import { runCliqSetupOnboarding } from "./setup-onboarding.js";
import { runCliqSetupProvisioning } from "./setup-provisioning-flow.js";
import { describeCliqInboundVerification } from "./inbound-verification.js";

const CHANNEL = "cliq" as const;
const DEFAULT_ACCOUNT_ID = "default";

/** Env vars consulted by the env-shortcut / use-env prompts. */
export const CLIQ_ENV_VARS = {
  clientId: "CLIQ_CLIENT_ID",
  clientSecret: "CLIQ_CLIENT_SECRET",
  webhookSecret: "CLIQ_WEBHOOK_SECRET",
  refreshToken: "CLIQ_REFRESH_TOKEN",
} as const;

/** Read the `channels.cliq` section as a mutable record. */
function readCliqSection(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = (cfg as unknown as { channels?: Record<string, unknown> }).channels;
  return (channels?.[CHANNEL] as Record<string, unknown> | undefined) ?? {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A channel is configured iff the required OAuth/bot fields and the inbound
 * webhook secret are set. Secret fields use `hasConfiguredSecretInput` so a
 * SecretRef-configured value (the form `openclaw secrets apply` produces)
 * still counts as present.
 */
export function isCliqChannelConfigured(cfg: OpenClawConfig, _accountId?: string): boolean {
  const section = readCliqSection(cfg);
  return Boolean(
    asString(section.clientId) &&
      hasConfiguredSecretInput(section.clientSecret) &&
      asString(section.botId) &&
      hasConfiguredSecretInput(section.webhookSecret),
  );
}

/** Patch the top-level `channels.cliq` section with a partial record. */
function patchCliqSection(
  cfg: OpenClawConfig,
  patch: Record<string, unknown>,
): OpenClawConfig {
  const next = structuredClone(cfg) as unknown as {
    channels?: Record<string, Record<string, unknown>>;
  };
  if (!next.channels) next.channels = {};
  const existing = next.channels[CHANNEL] ?? {};
  const merged: Record<string, unknown> = { ...existing, ...patch, enabled: true };
  // An explicit `undefined` in the patch means "clear this field". Deleting the
  // key rather than leaving it present-but-undefined keeps the cleared state
  // independent of how a given writer serializes undefined values.
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
  }
  next.channels[CHANNEL] = merged;
  return next as unknown as OpenClawConfig;
}

export interface CliqSetupCredentials {
  clientId?: string;
  clientSecret?: string;
  botId?: string;
  botName?: string;
  webhookSecret?: string;
  refreshToken?: string;
}

/**
 * Prompt for the core Cliq credentials/fields, reusing existing config
 * values when the operator confirms "keep". Pure w.r.t. the prompter — no
 * I/O of its own — so it is unit-testable with a fake prompter.
 */
export async function promptCliqCredentials(
  prompter: WizardPrompter,
  cfg: OpenClawConfig,
): Promise<CliqSetupCredentials> {
  const section = readCliqSection(cfg);
  const existingClientId = asString(section.clientId);
  const existingClientSecret = asString(section.clientSecret);
  const existingBotId = asString(section.botId);
  const existingBotName = asString(section.botName);
  const existingWebhookSecret = asString(section.webhookSecret);
  const existingRefreshToken = asString(section.refreshToken);

  const envClientId = asString(process.env[CLIQ_ENV_VARS.clientId]);
  const envClientSecret = asString(process.env[CLIQ_ENV_VARS.clientSecret]);
  const envWebhookSecret = asString(process.env[CLIQ_ENV_VARS.webhookSecret]);
  const envRefreshToken = asString(process.env[CLIQ_ENV_VARS.refreshToken]);

  const required = (value: string) =>
    value.trim() ? undefined : "This field is required.";

  const maybeUseEnv = async (
    label: string,
    envVar: string,
    envValue: string | undefined,
  ): Promise<boolean> => {
    if (!envValue) return false;
    return prompter.confirm({
      message: `Use ${label} from $${envVar}?`,
      initialValue: true,
    });
  };

  // Client ID
  let clientId = existingClientId;
  if (clientId) {
    if (
      await prompter.confirm({
        message: "Keep the existing Client ID?",
        initialValue: true,
      })
    ) {
      // keep
    } else if (await maybeUseEnv("Client ID", CLIQ_ENV_VARS.clientId, envClientId)) {
      clientId = envClientId;
    } else {
      clientId = await prompter.text({
        message: "Zoho Client ID",
        placeholder: "1000.XXXXXXXXXXXXXXXX.XXXXXXXXXXXXXXXX",
        initialValue: existingClientId,
        validate: required,
      });
    }
  } else if (envClientId && (await maybeUseEnv("Client ID", CLIQ_ENV_VARS.clientId, envClientId))) {
    clientId = envClientId;
  } else {
    clientId = await prompter.text({
      message: "Zoho Client ID",
      placeholder: "1000.XXXXXXXXXXXXXXXX.XXXXXXXXXXXXXXXX",
      validate: required,
    });
  }

  // Client Secret (sensitive)
  let clientSecret = existingClientSecret;
  if (clientSecret) {
    if (
      await prompter.confirm({
        message: "Keep the existing Client Secret?",
        initialValue: true,
      })
    ) {
      // keep
    } else if (envClientSecret && (await maybeUseEnv("Client Secret", CLIQ_ENV_VARS.clientSecret, envClientSecret))) {
      clientSecret = envClientSecret;
    } else {
      clientSecret = await prompter.text({
        message: "Zoho Client Secret",
        placeholder: "••••••••••••••••",
        sensitive: true,
        validate: required,
      });
    }
  } else if (envClientSecret && (await maybeUseEnv("Client Secret", CLIQ_ENV_VARS.clientSecret, envClientSecret))) {
    clientSecret = envClientSecret;
  } else {
    clientSecret = await prompter.text({
      message: "Zoho Client Secret",
      placeholder: "••••••••••••••••",
      sensitive: true,
      validate: required,
    });
  }

  // Bot unique name (required)
  let botId = existingBotId;
  if (botId) {
    if (
      await prompter.confirm({
        message: "Keep the existing bot unique name?",
        initialValue: true,
      })
    ) {
      // keep
    } else {
      botId = await prompter.text({
        message: "Cliq bot unique name (used in the bot message API URL)",
        placeholder: "openclaw-bot",
        initialValue: existingBotId,
        validate: required,
      });
    }
  } else {
    botId = await prompter.text({
      message: "Cliq bot unique name (used in the bot message API URL)",
      placeholder: "openclaw-bot",
      validate: required,
    });
  }

  // Bot display name (optional — used for mention stripping)
  let botName = existingBotName;
  const keepBotName = botName
    ? await prompter.confirm({
        message: "Keep the existing bot display name?",
        initialValue: true,
      })
    : false;
  if (botName && keepBotName) {
    // keep
  } else if (!botName || !keepBotName) {
    botName = await prompter.text({
      message: "Cliq bot display name (used for mention stripping; optional)",
      placeholder: "OpenClaw",
      initialValue: existingBotName,
    });
    if (botName.trim() === "") botName = undefined;
  }

  // Webhook secret (required: the inbound webhook fails closed without it)
  let webhookSecret = existingWebhookSecret;
  if (webhookSecret) {
    if (
      await prompter.confirm({
        message: "Keep the existing webhook secret?",
        initialValue: true,
      })
    ) {
      // keep
    } else if (
      envWebhookSecret &&
      (await maybeUseEnv("webhook secret", CLIQ_ENV_VARS.webhookSecret, envWebhookSecret))
    ) {
      webhookSecret = envWebhookSecret;
    } else {
      webhookSecret = await prompter.text({
        message:
          "Webhook shared secret (sent in x-cliq-webhook-secret by your Deluge handler; required)",
        placeholder: "••••••••••••••••",
        sensitive: true,
        validate: required,
      });
    }
  } else if (
    envWebhookSecret &&
    (await maybeUseEnv("webhook secret", CLIQ_ENV_VARS.webhookSecret, envWebhookSecret))
  ) {
    webhookSecret = envWebhookSecret;
  } else {
    webhookSecret = await prompter.text({
      message:
        "Webhook shared secret (sent in x-cliq-webhook-secret by your Deluge handler; required)",
      placeholder: "••••••••••••••••",
      sensitive: true,
      validate: required,
    });
  }

  // Refresh token (optional but required for channel posts + message edits).
  // The client_credentials grant cannot obtain a usable token for
  // ZohoCliq.Channels.UPDATE / ZohoCliq.Messages.UPDATE; a user-context
  // refresh token (obtained once via the self-client authorization_code
  // flow — see README §3) is required for the channel reply + live-edit
  // paths. DM-only setups can leave this blank.
  let refreshToken = existingRefreshToken;
  if (refreshToken) {
    if (
      await prompter.confirm({
        message: "Keep the existing refresh token?",
        initialValue: true,
      })
    ) {
      // keep
    } else if (
      envRefreshToken &&
      (await maybeUseEnv("refresh token", CLIQ_ENV_VARS.refreshToken, envRefreshToken))
    ) {
      refreshToken = envRefreshToken;
    } else {
      refreshToken = await prompter.text({
        message:
          "User-context OAuth refresh token (required for channel posts / message edits; leave empty for DM-only)",
        placeholder: "1000.abcdef…",
        sensitive: true,
      });
      if (refreshToken.trim() === "") refreshToken = undefined;
    }
  } else if (
    envRefreshToken &&
    (await maybeUseEnv("refresh token", CLIQ_ENV_VARS.refreshToken, envRefreshToken))
  ) {
    refreshToken = envRefreshToken;
  } else {
    refreshToken = await prompter.text({
      message:
        "User-context OAuth refresh token (required for channel posts / message edits; leave empty for DM-only — see README §3)",
      placeholder: "1000.abcdef…",
      sensitive: true,
    });
    if (refreshToken.trim() === "") refreshToken = undefined;
  }

  return { clientId, clientSecret, botId, botName, webhookSecret, refreshToken };
}

/** Apply collected credentials to the channel config section. */
export function applyCliqCredentials(
  cfg: OpenClawConfig,
  creds: CliqSetupCredentials,
): OpenClawConfig {
  const patch: Record<string, unknown> = {};
  if (creds.clientId) patch.clientId = creds.clientId;
  if (creds.clientSecret) patch.clientSecret = creds.clientSecret;
  if (creds.botId) patch.botId = creds.botId;
  if (creds.botName !== undefined) patch.botName = creds.botName;
  if (creds.webhookSecret !== undefined) patch.webhookSecret = creds.webhookSecret;
  if (creds.refreshToken !== undefined) patch.refreshToken = creds.refreshToken;
  return patchCliqSection(cfg, patch);
}

/**
 * Resolve the currently configured data center from the existing `oauthBase`
 * (preferred) or `apiBase` field of the `channels.cliq` section. Returns the
 * DC id when one of the configured bases matches a known region, otherwise
 * `undefined` (so the prompt defaults to EU — the plugin's historical
 * default, preserving backward compatibility for existing EU installs).
 */
export function detectConfiguredCliqDataCenter(
  cfg: OpenClawConfig,
): string | undefined {
  const section = readCliqSection(cfg);
  const oauthBase = asString(section.oauthBase);
  if (oauthBase) {
    const dc = findCliqDataCenterByOauthBase(oauthBase);
    if (dc) return dc.id;
  }
  const apiBase = asString(section.apiBase);
  if (apiBase) {
    const dc = findCliqDataCenterByApiBase(apiBase);
    if (dc) return dc.id;
  }
  return undefined;
}

/**
 * Prompt the operator to select their Zoho data center (region). EU is the
 * default and the preselected value when no region is detectable from the
 * existing config; an existing `oauthBase` / `apiBase` is reused so a re-run
 * over a non-EU account does not silently reset to EU. Returns the selected DC
 * id (never `undefined` — `select` always resolves to one of the options).
 */
export async function promptCliqDataCenter(
  prompter: WizardPrompter,
  cfg: OpenClawConfig,
): Promise<string> {
  const currentDcId =
    detectConfiguredCliqDataCenter(cfg) ?? CLIQ_DEFAULT_DC_ID;
  const selected = await prompter.select<string>({
    message: "Select your Zoho data center (region). Pick the domain you log into Zoho at.",
    options: CLIQ_DATA_CENTERS.map((dc) => ({
      value: dc.id,
      label: dc.label,
    })),
    initialValue: currentDcId,
  });
  return selected;
}

/**
 * Apply a data-center selection to the channel config: writes `oauthBase` +
 * `apiBase` together from the region→endpoints map. Falls back to the EU
 * default when the id is unknown (defensive — `promptCliqDataCenter` only ever
 * returns a known id).
 */
export function applyCliqDataCenter(
  cfg: OpenClawConfig,
  dcId: string,
): OpenClawConfig {
  const dc = findCliqDataCenterById(dcId) ?? getDefaultCliqDataCenter();
  return patchCliqSection(cfg, { oauthBase: dc.oauthBase, apiBase: dc.apiBase });
}

/** Resolve a CliqDataCenter by id with a safe EU fallback (never throws). */
export function resolveCliqDataCenterOrEu(dcId: string | undefined): CliqDataCenter {
  return (dcId ? findCliqDataCenterById(dcId) : undefined) ?? getDefaultCliqDataCenter();
}

/**
 * Prompt for the public webhook URL (issue #96).
 *
 * Zoho Cliq delivers inbound messages by calling the gateway, so setup needs
 * to know the public URL in order to verify that the path actually works.
 * Skipping is allowed (the operator may not have deployed the endpoint yet),
 * but inbound is then not reported as ready.
 */
export async function promptCliqPublicWebhookUrl(
  prompter: WizardPrompter,
  cfg: OpenClawConfig,
): Promise<string | undefined> {
  const existing = asString(readCliqSection(cfg).publicWebhookUrl);
  if (existing) {
    const keep = await prompter.confirm({
      message: `Keep the existing public webhook URL (${existing})?`,
      initialValue: true,
    });
    if (keep) return existing;
  }
  const entered = await prompter.text({
    message:
      "Public webhook URL Zoho will POST to (https://<host>/cliq/webhook; leave empty to skip verification)",
    placeholder: "https://cliq.example.com/cliq/webhook",
    initialValue: existing,
  });
  const trimmed = entered.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Persist the public webhook URL so later runs and doctor can reuse it. */
export function applyCliqPublicWebhookUrl(
  cfg: OpenClawConfig,
  url: string | undefined,
): OpenClawConfig {
  if (!url) return cfg;
  return patchCliqSection(cfg, { publicWebhookUrl: url });
}

/**
 * Persist the inbound verification outcome (issue #96).
 *
 * Without this, the readiness verdict only exists as a transient wizard note
 * and every later status surface would still call the channel "Configured"
 * based on credentials alone. A run that is not ready explicitly CLEARS a
 * previous timestamp so a formerly working install cannot keep claiming a
 * stale verification after its endpoint broke.
 */
export function applyCliqInboundVerification(
  cfg: OpenClawConfig,
  readiness: CliqInboundReadiness,
  now: Date = new Date(),
): OpenClawConfig {
  const at = now.toISOString();
  return patchCliqSection(cfg, {
    inboundVerifiedAt: readiness.ready ? at : undefined,
    inboundVerificationFailedAt: readiness.ready ? undefined : at,
  });
}

/**
 * Show a wizard note without ever letting the prompter abort setup. Credentials
 * are already written by the time inbound is verified, so a prompter failure
 * (non-TTY / CI run) must not fail finalize.
 */
async function noteSafely(
  prompter: WizardPrompter,
  message: string,
  title: string,
): Promise<void> {
  try {
    await prompter.note(message, title);
  } catch {
    // Reporting is best-effort; the readiness verdict is still returned.
  }
}

/**
 * Verify public inbound delivery during setup and report readiness.
 *
 * This is the gate required by issue #96: setup must not mark inbound Cliq
 * ready when the public webhook is unreachable or unauthenticated. A failure
 * is surfaced to the operator with the specific failing boundary rather than
 * silently downgraded, and a crashing preflight never aborts the wizard —
 * setup still completes, it just does not claim inbound works.
 */
export async function verifyCliqInboundDuringSetup(params: {
  cfg: OpenClawConfig;
  url: string | undefined;
  prompter: WizardPrompter;
  runPreflight?: (options: {
    url: string;
    secret: string | undefined;
  }) => Promise<CliqPreflightReport>;
}): Promise<CliqInboundReadiness> {
  const section = readCliqSection(params.cfg);
  const configured = isCliqChannelConfigured(params.cfg);
  // Resolve through the canonical secret path rather than reading the raw
  // field: `openclaw secrets apply` stores a structured SecretRef, and a
  // plain string may be a "$ENV_VAR" shorthand. Reading the raw value would
  // either skip the probe on a correctly configured install or send the
  // literal "$ENV_VAR" as the secret.
  const resolvedSecret = resolveCliqSecretString({
    cfg: params.cfg,
    value: section.webhookSecret,
    path: "channels.cliq.webhookSecret",
  });
  const secret = resolvedSecret === "" ? undefined : resolvedSecret;

  let preflight: CliqPreflightReport | undefined;
  if (params.url && configured) {
    const run = params.runPreflight ?? runCliqWebhookPreflight;
    try {
      preflight = await run({ url: params.url, secret });
    } catch (err) {
      const readiness: CliqInboundReadiness = {
        ready: false,
        reason: `the public webhook preflight failed to run: ${String(err)}`,
      };
      await noteSafely(params.prompter, readiness.reason, "Zoho Cliq inbound");
      return readiness;
    }
  }

  const readiness = resolveCliqInboundReadiness({
    configured,
    publicUrl: params.url,
    preflight,
  });

  const lines = readiness.ready
    ? [`Inbound Cliq verified: ${readiness.reason}`]
    : [
        `Inbound Cliq is NOT ready: ${readiness.reason}`,
        "",
        "See docs/setup/public-webhook.md for deployment options and troubleshooting.",
      ];
  if (preflight) lines.push("", ...formatCliqPreflightReport(preflight));
  await noteSafely(params.prompter, lines.join("\n"), "Zoho Cliq inbound");

  return readiness;
}

export async function promptCliqWelcomeOptIn(
  prompter: WizardPrompter,
  cfg: OpenClawConfig,
): Promise<OpenClawConfig> {
  const section = readCliqSection(cfg);
  const welcome = section.welcome as Record<string, unknown> | undefined;
  const alreadyEnabled = welcome?.enabled === true;
  let enable: boolean;
  try {
    enable = await prompter.confirm({
      message: alreadyEnabled
        ? "Keep greeting users with a welcome DM when they subscribe to the bot?"
        : "Greet users with a welcome DM when they subscribe to the bot? (needs the Cliq Welcome Handler)",
      initialValue: alreadyEnabled,
    });
  } catch {
    return cfg;
  }
  if (!enable) {
    if (!welcome) return cfg;
    return patchCliqSection(cfg, { welcome: { ...welcome, enabled: false } });
  }
  await noteSafely(
    prompter,
    [
      "The greeting only fires once the bot's Welcome Handler forwards subscribe events to",
      "<gateway>/cliq/webhook (README §5a shows the Deluge script). DM admission still applies:",
      "a denied or un-paired subscriber is never greeted.",
    ].join("\n"),
    "Zoho Cliq welcome",
  );
  return patchCliqSection(cfg, { welcome: { ...(welcome ?? {}), enabled: true } });
}

const cliqFinalize: NonNullable<ChannelSetupWizard["finalize"]> = async ({
  cfg,
  prompter,
}) => {
  // Prompt for the Zoho data center first so the printed setup instructions
  // reference the chosen region's API Console URL and the credentials are
  // stored alongside the matching `oauthBase` / `apiBase`. EU remains the
  // default (the plugin's historical default region) so existing EU installs
  // re-running the wizard stay on EU. See issue #46.
  const dcId = await promptCliqDataCenter(prompter, cfg);
  const dc = resolveCliqDataCenterOrEu(dcId);
  const cfgWithDc = applyCliqDataCenter(cfg, dc.id);

  await prompter.note(
    [
      `Create a self-client at ${dc.consoleUrl} (${dc.label}) with scopes:`,
      "  ZohoCliq.Webhooks.CREATE, ZohoCliq.Channels.UPDATE, ZohoCliq.Channels.READ,",
      "  ZohoCliq.Users.READ, ZohoCliq.Bots.READ, ZohoCliq.Messages.UPDATE.",
      "Bot DMs use client_credentials; channel posts + message edits need a",
      "user-context refresh token — obtain one via the self-client",
      "authorization_code flow (see README §3) and set refreshToken below.",
      "Then register a Deluge webhook handler in your Cliq bot that POSTs to",
      "<gateway>/cliq/webhook with the x-cliq-webhook-secret header.",
    ].join("\n"),
    "Zoho Cliq setup",
  );

  const creds = await promptCliqCredentials(prompter, cfgWithDc);
  let next = applyCliqCredentials(cfgWithDc, creds);

  // Issue #96: having credentials proves nothing about inbound delivery —
  // Zoho has to be able to CALL the gateway. Ask for the public URL and
  // verify the whole path (DNS, TLS, proxy, route, secret) with a
  // non-dispatching probe. Setup completes either way, but it must not
  // claim inbound Cliq is ready when the endpoint is unreachable.
  const publicUrl = await promptCliqPublicWebhookUrl(prompter, next);
  next = applyCliqPublicWebhookUrl(next, publicUrl);
  const readiness = await verifyCliqInboundDuringSetup({
    cfg: next,
    url: publicUrl,
    prompter,
  });
  // Persist the verdict so status/doctor keep reporting the truth after the
  // wizard exits, instead of inferring readiness from credentials alone.
  next = applyCliqInboundVerification(next, readiness);

  next = await promptCliqWelcomeOptIn(prompter, next);

  // Issue #94: inspect the Zoho-held bot/handlers and offer idempotent
  // provisioning. The dry-run is read-only and always runs first; any
  // mutation (including repairing a handler whose URL matches but whose
  // secret does not) needs its own explicit confirmation. Without a public
  // webhook URL there is no target to provision, and a failure here must
  // never abort a setup whose credentials are already written.
  if (publicUrl && isCliqChannelConfigured(next)) {
    try {
      await runCliqSetupProvisioning({
        cfg: next,
        publicWebhookUrl: publicUrl,
        prompter,
        accountId: DEFAULT_ACCOUNT_ID,
        includeWelcome:
          (readCliqSection(next).welcome as { enabled?: unknown } | undefined)?.enabled === true,
      });
    } catch {
      await noteSafely(
        prompter,
        "Bot and handler provisioning could not be inspected; no Zoho-held handler was changed.",
        "Zoho Cliq bot/handler provisioning",
      );
    }
  }

  await runCliqSetupOnboarding({
    cfg: next,
    prompter,
    accountId: DEFAULT_ACCOUNT_ID,
    publicWebhookUrl: publicUrl,
  });

  // Trusted-organization mode is opt-in. Only an existing deliberately open
  const section = readCliqSection(next);
  const allowFrom = Array.isArray(section.allowFrom)
    ? section.allowFrom.filter((value): value is string => typeof value === "string")
    : [];
  const organizationWide =
    section.dmPolicy === "open" ||
    allowFrom.some((value) => value.trim() === "*") ||
    section.groupPolicy === "open";
  const trustedOrganization = section.trustedOrganization as
    | { acknowledged?: unknown; label?: unknown }
    | undefined;
  if (organizationWide && trustedOrganization?.acknowledged !== true) {
    await prompter.note(
      "Trusted-organization mode does not verify Zoho organization membership per request. The enforced boundary is the authenticated private webhook secret plus the installed bot handler. It allows organization-wide DM/group access and exposes the configured agent tools according to the effective tool policy.",
      "Trusted organization",
    );
    const acknowledge = await prompter.confirm({
      message: "Acknowledge this organization-wide exposure without a cryptographic tenant boundary?",
      initialValue: false,
    });
    if (acknowledge) {
       const current = trustedOrganization;
       next = {
        ...next,
        channels: {
          ...(next as { channels?: Record<string, unknown> }).channels,
          cliq: {
            ...section,
            trustedOrganization: {
              acknowledged: true,
              ...(typeof current?.label === "string" && current.label
                ? { label: current.label }
                : {}),
              acknowledgedAt: new Date().toISOString(),
            },
          },
        },
      } as typeof next;
    }
  }

  return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
};

export const cliqSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL,
  status: createStandardChannelSetupStatus({
    channelLabel: "Zoho Cliq",
    configuredLabel: "Configured",
    unconfiguredLabel: "Needs OAuth client + bot + webhook secret",
    configuredHint: "Zoho Cliq bot is configured.",
    unconfiguredHint:
      "Add your Cliq OAuth client id/secret, bot unique name, and webhook secret to enable inbound delivery.",
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      isCliqChannelConfigured(cfg, accountId),
    resolveExtraStatusLines: ({ cfg }) => {
      const section = readCliqSection(cfg);
      const lines: string[] = [];
      const botId = asString(section.botId);
      if (botId) lines.push(`bot: ${botId}`);
      // Presence check must accept a SecretRef too — `openclaw secrets apply`
      // rewrites the plaintext into an object, which asString() would report
      // as "not set" on a correctly configured install.
      const webhookSecretSet = hasConfiguredSecretInput(section.webhookSecret);
      lines.push(`webhook secret: ${webhookSecretSet ? "set" : "not set"}`);
      // Issue #96: credentials alone never mean inbound delivery works, so
      // report the verification state explicitly instead of letting
      // "Configured" imply a reachable webhook.
      lines.push(
        describeCliqInboundVerification({
          publicUrl: asString(section.publicWebhookUrl),
          verifiedAt: asString(section.inboundVerifiedAt),
          failedAt: asString(section.inboundVerificationFailedAt),
        }),
      );
      const dcId = detectConfiguredCliqDataCenter(cfg);
      if (dcId) lines.push(`data center: ${dcId}`);
      return lines;
    },
  }),
  introNote: {
    title: "Zoho Cliq setup",
    lines: [
      "You'll need a Zoho Cliq bot plus an OAuth self-client for your Zoho data",
      "center (region). The wizard prompts for the region first so the printed",
      "API Console URL and the stored `oauthBase` / `apiBase` match your Zoho",
      "account. The bot unique name is what you registered in Cliq's bot console;",
      "it is used in the bot message API URL. The webhook secret is a shared",
      "string your Deluge handler sends in the x-cliq-webhook-secret header.",
    ],
  },
  credentials: [],
  finalize: cliqFinalize,
  groupAccess: {
    label: "Zoho Cliq groups",
    placeholder: "dev-team, ops",
    helpTitle: "Zoho Cliq group access",
    helpLines: [
      "Groups default to disabled on a fresh generic setup. Allowlist restricts",
      "the bot to named channels (unique names from `openclaw directory`). Open",
      "lets any channel the bot is in mention it. This does not verify Zoho",
      "organization membership; the webhook secret is the trust boundary.",
    ],
    currentPolicy: ({ cfg }) => {
      const raw = readCliqSection(cfg).groupPolicy;
      return raw === "open" || raw === "allowlist" || raw === "disabled"
        ? raw
        : "disabled";
    },
    currentEntries: ({ cfg }) => Object.keys(readCliqSection(cfg).groups ?? {}),
    updatePrompt: ({ cfg }) => Object.keys(readCliqSection(cfg).groups ?? {}).length > 0,
    setPolicy: ({ cfg, policy }) =>
      patchCliqSection(cfg, { groupPolicy: policy }),
    resolveAllowlist: async ({ cfg, entries, prompter }) => {
      const resolved = await resolveCliqDirectoryAllowlist({
        cfg,
        entries,
        kind: "group",
      });
      const unresolved = resolved.filter((entry) => !entry.resolved);
      if (unresolved.length > 0) {
        await prompter.note(
          `Unresolved channel names (kept as entered, not silently broadened): ${unresolved.map((entry) => entry.input).join(", ")}`,
          "Zoho Cliq groups",
        );
      }
      return resolved.map((entry) => entry.id);
    },
    applyAllowlist: ({ cfg, resolved }) => {
      const ids = Array.isArray(resolved)
        ? resolved.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const existing = (readCliqSection(cfg).groups ?? {}) as Record<string, unknown>;
      const groups: Record<string, unknown> = {};
      for (const id of ids) groups[id] = existing[id] ?? {};
      return patchCliqSection(cfg, { groups, groupPolicy: "allowlist" });
    },
  },
  dmPolicy: createTopLevelChannelDmPolicy({
    label: "Zoho Cliq",
    channel: CHANNEL,
    policyKey: "dmPolicy",
    allowFromKey: "allowFrom",
    getCurrent: (cfg) => {
      const raw = readCliqSection(cfg).dmPolicy;
      return (raw as
        | "pairing"
        | "allowlist"
        | "open"
        | "disabled"
        | undefined) ?? "allowlist";
    },
    promptAllowFrom: async ({ cfg, prompter }) => {
      const existing = (readCliqSection(cfg).allowFrom ?? []) as string[];
      const raw = await prompter.text({
        message: "Zoho Cliq DM allowlist (comma-separated user ids, emails, or names)",
        placeholder: "user@example.com, 123456789",
        ...(existing.length > 0 ? { initialValue: existing.join(", ") } : {}),
      });
      const entries = raw
        .split(/[\n,;]+/g)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (entries.length === 0) return cfg;
      const resolved = await resolveCliqDirectoryAllowlist({
        cfg,
        entries,
        kind: "user",
      });
      const unresolved = resolved.filter((entry) => !entry.resolved);
      if (unresolved.length > 0) {
        await prompter.note(
          `Unresolved senders (kept exactly as entered, never widened): ${unresolved.map((entry) => entry.input).join(", ")}`,
          "Zoho Cliq allowlist",
        );
      }
      return patchCliqSection(cfg, {
        allowFrom: Array.from(new Set(resolved.map((entry) => entry.id))),
      });
    },
  }),
  disable: (cfg) => setSetupChannelEnabled(cfg, CHANNEL, false),
};
