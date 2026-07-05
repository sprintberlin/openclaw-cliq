import {
  createStandardChannelSetupStatus,
  createTopLevelChannelDmPolicy,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";

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
 * A channel is configured iff the three required OAuth/bot fields are set.
 * `clientSecret` uses `hasConfiguredSecretInput` so a SecretRef-configured
 * secret (the form `openclaw secrets apply` produces) still counts as present
 * — otherwise the setup wizard would re-prompt for a plaintext value and
 * clobber the configured ref.
 */
export function isCliqChannelConfigured(cfg: OpenClawConfig, _accountId?: string): boolean {
  const section = readCliqSection(cfg);
  return Boolean(
    asString(section.clientId) &&
      hasConfiguredSecretInput(section.clientSecret) &&
      asString(section.botId),
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
  next.channels[CHANNEL] = { ...existing, ...patch, enabled: true };
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
 * Prompt for the five core Cliq credentials/fields, reusing existing config
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

  // Webhook secret (optional but recommended)
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
          "Webhook shared secret (sent in x-cliq-webhook-secret by your Deluge handler; recommended)",
        placeholder: "••••••••••••••••",
        sensitive: true,
      });
      if (webhookSecret.trim() === "") webhookSecret = undefined;
    }
  } else if (
    envWebhookSecret &&
    (await maybeUseEnv("webhook secret", CLIQ_ENV_VARS.webhookSecret, envWebhookSecret))
  ) {
    webhookSecret = envWebhookSecret;
  } else {
    webhookSecret = await prompter.text({
      message:
        "Webhook shared secret (sent in x-cliq-webhook-secret by your Deluge handler; leave empty to skip)",
      placeholder: "••••••••••••••••",
      sensitive: true,
    });
    if (webhookSecret.trim() === "") webhookSecret = undefined;
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

const cliqFinalize: NonNullable<ChannelSetupWizard["finalize"]> = async ({
  cfg,
  prompter,
}) => {
  await prompter.note(
    [
      "Create a self-client at https://api-console.zoho.eu (EU endpoint) with scopes:",
      "  ZohoCliq.Webhooks.CREATE, ZohoCliq.Channels.UPDATE, ZohoCliq.Channels.READ,",
      "  ZohoCliq.Users.READ, ZohoCliq.Messages.UPDATE.",
      "Bot DMs use client_credentials; channel posts + message edits need a",
      "user-context refresh token — obtain one via the self-client",
      "authorization_code flow (see README §3) and set refreshToken below.",
      "Then register a Deluge webhook handler in your Cliq bot that POSTs to",
      "<gateway>/cliq/webhook with the x-cliq-webhook-secret header.",
    ].join("\n"),
    "Zoho Cliq setup",
  );

  const creds = await promptCliqCredentials(prompter, cfg);
  const next = applyCliqCredentials(cfg, creds);
  return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
};

export const cliqSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL,
  status: createStandardChannelSetupStatus({
    channelLabel: "Zoho Cliq",
    configuredLabel: "Configured",
    unconfiguredLabel: "Needs OAuth client + bot",
    configuredHint: "Zoho Cliq bot is configured.",
    unconfiguredHint:
      "Add your Cliq OAuth client id/secret and bot unique name to enable the channel.",
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      isCliqChannelConfigured(cfg, accountId),
    resolveExtraStatusLines: ({ cfg }) => {
      const section = readCliqSection(cfg);
      const lines: string[] = [];
      const botId = asString(section.botId);
      if (botId) lines.push(`bot: ${botId}`);
      const webhookSecret = asString(section.webhookSecret);
      lines.push(`webhook secret: ${webhookSecret ? "set" : "not set"}`);
      return lines;
    },
  }),
  introNote: {
    title: "Zoho Cliq setup",
    lines: [
      "You'll need a Zoho Cliq bot plus an OAuth self-client (EU endpoint).",
      "The bot unique name is what you registered in Cliq's bot console; it is",
      "used in the bot message API URL. The webhook secret is a shared string",
      "your Deluge handler sends in the x-cliq-webhook-secret header.",
    ],
  },
  credentials: [],
  finalize: cliqFinalize,
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
  }),
  disable: (cfg) => setSetupChannelEnabled(cfg, CHANNEL, false),
};
