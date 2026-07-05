import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type {
  ChannelLegacyStateMigrationPlan,
  ChannelLifecycleAdapter,
} from "openclaw/plugin-sdk/channel-runtime";

/**
 * Legacy config / state migration surface for the Cliq channel.
 *
 * Zoho's own ecosystem — the OAuth console, the REST API docs, and the Deluge
 * scripting language — uses snake_case identifiers (`client_id`,
 * `client_secret`, `bot_id`, `webhook_secret`, `refresh_token`, …). An
 * operator copying values straight from the Zoho console or a Deluge sample
 * script will naturally paste snake_case keys into `openclaw.json`. The Cliq
 * manifest schema is camelCase with `additionalProperties: false`, so a
 * snake_case key both (a) fails schema validation and (b) is silently ignored
 * by `resolveCliqConfig`, leaving the channel apparently "configured but
 * broken". This module gives `openclaw doctor` a deterministic, side-effect-
 * free migration path: snake_case → camelCase, canonical-wins on conflict.
 *
 * The surface mirrors the SDK's bundled `legacy-state-migrations-api.ts`
 * bundle (Telegram / iMessage ship one): the doctor adapter contributes
 * `legacyConfigRules` (declarative warnings surfaced by `openclaw doctor`),
 * `normalizeCompatibilityConfig` (the in-memory compat pass doctor applies),
 * and `repairConfig` (the `--fix` write path). The lifecycle adapter
 * contributes `detectLegacyStateMigrations` for future plugin-state file
 * migrations (dedupe tombstones, OAuth token cache, chat-id cache); none
 * exist on disk yet, so it returns an empty plan today — the plumbing is in
 * place so a future state file can be migrated by adding a plan entry here
 * instead of inventing a new adapter.
 */

/**
 * Snake_case → camelCase mapping for the keys an operator is most likely to
 * paste from Zoho docs. Each entry is a *legacy alias*, not a supported
 * alternate spelling: the camelCase form is canonical and the snake_case form
 * is rewritten on sight. Keep this table in sync with the manifest schema's
 * `channelConfigs.cliq.schema.properties` and `resolveCliqConfig`'s reads.
 */
const CLIQ_SNAKE_CASE_CONFIG_KEYS: ReadonlyArray<{
  snake: string;
  camel: string;
}> = [
  { snake: "client_id", camel: "clientId" },
  { snake: "client_secret", camel: "clientSecret" },
  { snake: "bot_id", camel: "botId" },
  { snake: "bot_name", camel: "botName" },
  { snake: "webhook_secret", camel: "webhookSecret" },
  { snake: "refresh_token", camel: "refreshToken" },
  { snake: "allow_from", camel: "allowFrom" },
  { snake: "self_sender_ids", camel: "selfSenderIds" },
  { snake: "dm_policy", camel: "dmPolicy" },
  { snake: "ack_policy", camel: "ackPolicy" },
];

function readCliqSection(
  cfg: OpenClawConfig,
): Record<string, unknown> | null {
  const channels = (cfg as unknown as { channels?: Record<string, unknown> })
    .channels;
  if (!channels || typeof channels !== "object") return null;
  const section = channels["cliq"];
  if (!section || typeof section !== "object") return null;
  return section as Record<string, unknown>;
}

/**
 * Declarative legacy-config rules. `openclaw doctor` walks the raw config and
 * for each rule whose `path` resolves to a defined value (and whose optional
 * `match` predicate passes) emits the rule's `message` as a warning. No
 * `match` predicate is needed here — a snake_case key is legacy whenever it
 * is present, regardless of whether the camelCase form is also set (the
 * canonical form wins on conflict in `normalizeCliqCompatibilityConfig`).
 */
export const cliqLegacyConfigRules: ChannelDoctorLegacyConfigRule[] =
  CLIQ_SNAKE_CASE_CONFIG_KEYS.map(({ snake, camel }) => ({
    path: ["channels", "cliq", snake],
    message: `channels.cliq.${snake} is the snake_case form copied from Zoho's API/Deluge docs; use the camelCase "${camel}" key. Run \`openclaw doctor --fix\` to migrate automatically.`,
  }));

/**
 * In-memory compatibility pass: rewrite snake_case Cliq channel keys to their
 * camelCase canonical form. The canonical key wins on conflict — if both
 * `client_id` and `clientId` are present, `clientId` is kept and the
 * snake_case copy is dropped (with a change note). The input config is never
 * mutated; a shallow-copied section is rewritten and reassembled with
 * spreads. Returns `{ config: cfg, changes: [] }` when there is nothing to
 * migrate so the doctor framework can short-circuit cleanly.
 */
export function normalizeCliqCompatibilityConfig(params: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const { cfg } = params;
  const raw = readCliqSection(cfg);
  const channels = (cfg as unknown as { channels?: Record<string, unknown> })
    .channels;
  if (!raw || !channels) {
    return { config: cfg, changes: [] };
  }
  const updated: Record<string, unknown> = { ...raw };
  const changes: string[] = [];
  let changed = false;
  for (const { snake, camel } of CLIQ_SNAKE_CASE_CONFIG_KEYS) {
    if (updated[snake] === undefined) continue;
    if (updated[camel] === undefined) {
      updated[camel] = updated[snake];
      changes.push(`Moved channels.cliq.${snake} → channels.cliq.${camel}.`);
    } else {
      changes.push(
        `Removed channels.cliq.${snake} (channels.cliq.${camel} already set).`,
      );
    }
    delete updated[snake];
    changed = true;
  }
  if (!changed) return { config: cfg, changes: [] };
  return {
    config: {
      ...(cfg as Record<string, unknown>),
      channels: { ...(channels as Record<string, unknown>), cliq: updated },
    } as unknown as OpenClawConfig,
    changes,
  };
}

/**
 * `openclaw doctor --fix` repair path. The snake_case rewrite is idempotent
 * and safe to apply unconditionally, so repair delegates to
 * `normalizeCliqCompatibilityConfig` — there is no destructive "remove" step
 * that requires a separate confirmation. Sync because the rewrite is pure.
 */
export function repairCliqConfig(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): ChannelDoctorConfigMutation {
  return normalizeCliqCompatibilityConfig({ cfg: params.cfg });
}

/**
 * Detect on-disk plugin-state files that should be migrated into the SDK's
 * plugin-state store. The Cliq channel keeps its ephemeral state
 * (claim/commit dedupe tombstones, OAuth access-token cache, resolved
 * channel chat-id cache) entirely in memory today, so there are no legacy
 * state files to import. The detector is wired (and tested) so a future
 * state file — e.g. a persisted token cache written by an older plugin
 * version — can be migrated by adding a `plugin-state-import` plan entry
 * here instead of introducing a new adapter surface.
 */
export function detectCliqLegacyStateMigrations(_params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  return [];
}

/**
 * Lifecycle adapter for the Cliq channel. Forwards `detectLegacyStateMigrations`
 * to the detector above. The other lifecycle hooks (account config change /
 * removal, startup maintenance) are intentionally omitted — the Cliq client
 * registry resolves accounts lazily and has no per-account state to flush.
 */
export const cliqLifecycleAdapter: ChannelLifecycleAdapter = {
  detectLegacyStateMigrations: detectCliqLegacyStateMigrations,
};
