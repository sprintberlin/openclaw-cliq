import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorEmptyAllowlistAccountContext,
} from "openclaw/plugin-sdk/channel-contract";
import {
  cliqLegacyConfigRules,
  normalizeCliqCompatibilityConfig,
  repairCliqConfig,
} from "./legacy-state-migrations.js";
import {
  findCliqDataCenterByApiBase,
  findCliqDataCenterByOauthBase,
} from "./region.js";

/**
 * Read the raw (possibly unconfigured) Cliq channel section from cfg. Returns
 * `null` when there is no `channels.cliq` object so doctor checks can treat
 * "unconfigured" and "absent" uniformly. The shape is intentionally loose
 * (Record<string, unknown>) so doctor can warn about unknown / legacy keys
 * without a typed config resolver that would throw on missing credentials.
 */
function readCliqSection(
  cfg: OpenClawConfig,
): Record<string, unknown> | null {
  const channels = (cfg as unknown as { channels?: Record<string, unknown> })
    .channels;
  if (!channels || typeof channels !== "object") return null;
  const section = (channels as Record<string, unknown>)["cliq"];
  if (!section || typeof section !== "object") return null;
  return section as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function isWildcardAllowFrom(allowFrom: string[]): boolean {
  return allowFrom.some((entry) => entry.trim() === "*");
}

/**
 * Cliq-specific doctor preview warnings. These run on every `openclaw doctor`
 * (and `openclaw plugins doctor`) invocation against the resolved config,
 * without touching the network — they are pure static config checks. The
 * warnings mirror what an operator would otherwise discover only at
 * delivery time:
 *
 *  - missing core credentials (clientId/clientSecret/botId),
 *  - missing `webhookSecret` (Cliq cannot verify inbound delivery without it,
 *    and the plugin rejects unauthed requests with 401),
 *  - `dmPolicy: "open"` combined with a wildcard `allowFrom: ["*"]` (any Cliq
 *    user can drive the agent — call this out as a security note),
 *  - `dmPolicy: "allowlist"` with an empty `allowFrom` (no DM can be admitted
 *    until the operator adds at least one sender id),
 *  - an `ackPolicy: "immediate"` opt-in (lost-message risk on crash — opt-in
 *    only when the Deluge `invokeUrl` timeout is tighter than the agent
 *    round-trip).
 *
 * Warnings are prefixed `- channels.cliq:` to match the convention the
 * bundled channels use in doctor output.
 */
function collectCliqPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
}): string[] {
  const section = readCliqSection(params.cfg);
  if (!section) return [];
  const warnings: string[] = [];
  const missing: string[] = [];
  if (!section.clientId) missing.push("clientId");
  if (!section.clientSecret) missing.push("clientSecret");
  if (!section.botId) missing.push("botId");
  if (missing.length > 0) {
    warnings.push(
      `- channels.cliq: missing required credential${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Run \`${params.doctorFixCommand}\` or \`openclaw configure\` to set them.`,
    );
  }
  if (!section.webhookSecret) {
    warnings.push(
      `- channels.cliq: webhookSecret is not set. Inbound Cliq delivery will be rejected with 401 because the plugin cannot verify the x-cliq-webhook-secret header. Run \`openclaw configure\` to set it (or run \`${params.doctorFixCommand}\` if managed).`,
    );
  }
  const dmPolicy =
    typeof section.dmPolicy === "string" ? section.dmPolicy : "allowlist";
  const allowFrom = asStringArray(section.allowFrom);
  if (dmPolicy === "open" && isWildcardAllowFrom(allowFrom)) {
    warnings.push(
      `- channels.cliq: dmPolicy is "open" and allowFrom contains a wildcard ("*"). Any Cliq user can drive this agent. Tighten allowFrom to a known sender list or switch dmPolicy to "allowlist".`,
    );
  }
  if (dmPolicy === "allowlist" && allowFrom.length === 0) {
    warnings.push(
      `- channels.cliq: dmPolicy is "allowlist" but allowFrom is empty. No DM will be admitted until at least one sender id is added (or dmPolicy is set to "open").`,
    );
  }
  if (section.ackPolicy === "immediate") {
    warnings.push(
      `- channels.cliq: ackPolicy is "immediate". A crash between ack and dispatch loses the inbound message. Use only when the Deluge invokeUrl timeout is tighter than the agent round-trip.`,
    );
  }
  // Data-center validation: warn when only one of `oauthBase` / `apiBase` is
  // set (the other defaults to EU, so a half-set config silently splits the
  // OAuth + REST calls across two regions), or when the two point at
  // different regions (a likely copy-paste mistake). See issue #46.
  const oauthBaseRaw = typeof section.oauthBase === "string" ? section.oauthBase : undefined;
  const apiBaseRaw = typeof section.apiBase === "string" ? section.apiBase : undefined;
  if (oauthBaseRaw || apiBaseRaw) {
    if (Boolean(oauthBaseRaw) !== Boolean(apiBaseRaw)) {
      warnings.push(
        `- channels.cliq: only one of oauthBase / apiBase is set (oauthBase=${oauthBaseRaw ?? "—"}, apiBase=${apiBaseRaw ?? "—"}). Set both together to the same Zoho data center — the unset one defaults to the EU endpoint, splitting OAuth + REST across regions. See README → Data centers.`,
      );
    } else if (oauthBaseRaw && apiBaseRaw) {
      const dcByOauth = findCliqDataCenterByOauthBase(oauthBaseRaw);
      const dcByApi = findCliqDataCenterByApiBase(apiBaseRaw);
      if (dcByOauth && dcByApi && dcByOauth.id !== dcByApi.id) {
        warnings.push(
          `- channels.cliq: oauthBase (${dcByOauth.label}) and apiBase (${dcByApi.label}) point at different Zoho data centers. Set both to the same region — see README → Data centers.`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Mutable-allowlist warnings: the doctor cannot safely rewrite a Cliq
 * allowlist because sender ids are workspace-specific (Zoho user ids / bot
 * unique names). Surface a wildcard allowlist as a warning doctor will not
 * auto-edit, so the operator knows to tighten it manually.
 */
function collectCliqMutableAllowlistWarnings(params: {
  cfg: OpenClawConfig;
}): string[] {
  const section = readCliqSection(params.cfg);
  if (!section) return [];
  const allowFrom = asStringArray(section.allowFrom);
  if (!isWildcardAllowFrom(allowFrom)) return [];
  return [
    `- channels.cliq: allowFrom contains a wildcard ("*"). doctor will not edit a wildcard allowlist automatically; tighten it to a known sender list manually.`,
  ];
}

/**
 * Cliq does not maintain a separate group-sender allowlist — group admission
 * is gated by the mention requirement, not an allowlist. The default
 * "empty group allowlist" warning would be misleading, so suppress it.
 */
function shouldSkipDefaultEmptyGroupAllowlistWarning(
  _params: ChannelDoctorEmptyAllowlistAccountContext,
): boolean {
  return true;
}

/**
 * Channel doctor adapter for Zoho Cliq.
 *
 * Contributes Cliq-specific diagnostics to `openclaw doctor` /
 * `openclaw plugins doctor`. The adapter is intentionally pure/static — it
 * never reaches the network — so doctor output is deterministic and safe to
 * run against an unconfigured or partially-configured account.
 *
 * What it surfaces:
 *  - `dmAllowFromMode: "topOnly"` — Cliq's DM allowlist lives only at the
 *    top-level `channels.cliq.allowFrom` (no per-account nesting yet), so
 *    doctor looks for it there and only there.
 *  - `collectPreviewWarnings` — missing credentials, missing webhook secret,
 *    wildcard + open DM policy, empty allowlist under "allowlist" policy,
 *    and the `ackPolicy: "immediate"` lost-message opt-in.
 *  - `collectMutableAllowlistWarnings` — wildcard allowlist doctor will not
 *    auto-edit.
 *  - `shouldSkipDefaultEmptyGroupAllowlistWarning` — Cliq groups are gated by
 *    mention, not a group allowlist, so the default empty-group-allowlist
 *    warning does not apply.
 *
 * `legacyConfigRules` / `normalizeCompatibilityConfig` / `repairConfig` are
 * contributed for the snake_case alias set operators paste from Zoho's
 * API/Deluge docs (`client_id`, `client_secret`, `bot_id`, …). See
 * `src/legacy-state-migrations.ts` for the rewrite logic; the rules surface
 * the same set as declarative doctor warnings.
 */
export const cliqDoctorAdapter: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  legacyConfigRules: cliqLegacyConfigRules,
  normalizeCompatibilityConfig: normalizeCliqCompatibilityConfig,
  repairConfig: repairCliqConfig,
  collectPreviewWarnings: collectCliqPreviewWarnings,
  collectMutableAllowlistWarnings: collectCliqMutableAllowlistWarnings,
  shouldSkipDefaultEmptyGroupAllowlistWarning,
};

/**
 * Pure helpers exported for tests + future diagnostics reuse.
 */
export {
  collectCliqPreviewWarnings,
  collectCliqMutableAllowlistWarnings,
  readCliqSection as readCliqDoctorSection,
  cliqLegacyConfigRules,
  normalizeCliqCompatibilityConfig,
  repairCliqConfig,
};
