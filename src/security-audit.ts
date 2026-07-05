import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  isSecretRef,
  coerceSecretRef,
} from "openclaw/plugin-sdk/secret-input-runtime";

/**
 * A single Cliq security audit finding. Mirrors the SDK's
 * `SecurityAuditFinding` shape (`{ checkId, severity, title, detail,
 * remediation? }`) — kept as a local structural type so this module has no
 * hard dependency on the internal `types-D7eu8baG` bundle. The registered
 * collector returns these objects verbatim; the gateway's audit runtime
 * surfaces them under `openclaw security audit`.
 */
export interface CliqSecurityAuditFinding {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
}

/**
 * Read the raw (possibly unconfigured) Cliq channel section from cfg. Returns
 * `null` when there is no `channels.cliq` object so audit checks can treat
 * "unconfigured" and "absent" uniformly. The shape is intentionally loose
 * (Record<string, unknown>) so the audit never throws on a partially-typed
 * section (a typed resolver like `resolveCliqConfig` would throw on missing
 * credentials, which is the wrong behavior for a security sweep — an
 * unconfigured channel should produce no findings, not an error).
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
 * Read the `secrets` block from config as a loose record, so
 * `coerceSecretRef` can be given the configured `defaults` (this lets
 * shorthand `$NAME` / `${NAME}` env markers count as SecretRefs, matching
 * what `openclaw secrets apply` would recognize). Mirrors the reader in
 * `secret-resolve.ts`.
 */
function readSecretsDefaults(cfg: OpenClawConfig):
  | { env?: string; file?: string; exec?: string }
  | undefined {
  const secrets = (cfg as unknown as {
    secrets?: { defaults?: { env?: string; file?: string; exec?: string } };
  }).secrets;
  return secrets?.defaults;
}

/**
 * Classify a Cliq secret-bearing config field for the plaintext-storage
 * finding. Returns:
 *  - `"plaintext"` when the value is a non-empty literal string (stored in
 *    the clear in `openclaw.json`),
 *  - `"ref"` when the value is a structured SecretRef (or a `$NAME` /
 *    `${NAME}` / legacy `secretref-env:` shorthand that `coerceSecretRef`
 *    recognizes),
 *  - `"missing"` when unset / empty / not a usable secret shape.
 */
function classifySecretField(
  value: unknown,
  defaults: ReturnType<typeof readSecretsDefaults>,
): "plaintext" | "ref" | "missing" {
  if (value == null) return "missing";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "missing";
    // `$NAME` / `${NAME}` / `secretref-env:` shorthands coerce to a SecretRef
    // — those count as ref-backed, NOT plaintext.
    if (coerceSecretRef(value, defaults)) return "ref";
    return "plaintext";
  }
  if (isSecretRef(value)) return "ref";
  // An object that is not a canonical SecretRef but might be a legacy /
  // hand-written ref shape: coerce tolerantly, otherwise treat as plaintext
  // (an unknown structured value is most likely a malformed literal).
  if (coerceSecretRef(value, defaults)) return "ref";
  return "plaintext";
}

/**
 * Collect Cliq-specific security audit findings.
 *
 * The collector is registered with the gateway via
 * `api.registerSecurityAuditCollector` in `registerFull`, and is invoked by
 * `openclaw security audit` (and any tooling that consumes the security-audit
 * runtime). It receives the resolved config and must return a list of
 * findings — never throw (a thrown collector would abort the whole audit
 * sweep; degrade to `[]` on any unexpected shape).
 *
 * Findings emitted:
 *
 *  - **`channels.cliq.webhook_secret.missing`** (critical): no
 *    `webhookSecret` is configured, so `verifyWebhookSecret` short-circuits
 *    to `true` and ANY party that can reach `/cliq/webhook` can forge
 *    inbound Deluge payloads and drive the agent. This is the highest-impact
 *    gap — the webhook is the trust boundary.
 *
 *  - **`channels.cliq.allow_from.wildcard`** (critical): `allowFrom` contains
 *    `"*"`, admitting every Cliq user. Under `dmPolicy: "open"` this is the
 *    default-allow footgun; under `dmPolicy: "allowlist"` it silently makes
 *    the allowlist a no-op. Either way any Cliq user can drive the agent.
 *
 *  - **`channels.cliq.dm_policy.open`** (warn): `dmPolicy: "open"` admits
 *    any Cliq user DM without an allowlist. Lower severity than a wildcard
 *    because the operator explicitly opted in, but still worth surfacing —
 *    pair with `allowFrom` or switch to `"allowlist"` / `"pairing"`.
 *
 *  - **`channels.cliq.secrets.plaintext`** (warn): one or more secret fields
 *    (`clientSecret`, `webhookSecret`, `refreshToken`) are stored as literal
 *    strings in `openclaw.json` rather than as SecretRefs. A literal secret
 *    in config is committed to disk / source control and exposed to anyone
 *    who can read the config file. `openclaw secrets apply` rewrites them
 *    into env / file / exec-backed SecretRefs.
 */
export function collectCliqSecurityAuditFindings(params: {
  cfg: OpenClawConfig;
}): CliqSecurityAuditFinding[] {
  const section = readCliqSection(params.cfg);
  if (!section) return [];
  const findings: CliqSecurityAuditFinding[] = [];

  const webhookSecretValue = section.webhookSecret;
  const webhookSecretMissing =
    classifySecretField(webhookSecretValue, readSecretsDefaults(params.cfg)) ===
    "missing";
  if (webhookSecretMissing) {
    findings.push({
      checkId: "channels.cliq.webhook_secret.missing",
      severity: "critical",
      title: "Cliq webhook secret is not configured",
      detail:
        'channels.cliq.webhookSecret is unset. Without it the plugin treats every inbound request as verified (verifyWebhookSecret returns true for any request), so any party that can reach /cliq/webhook can forge Deluge payloads and drive the agent. The webhook is the trust boundary — it must carry a shared secret.',
      remediation:
        "Set channels.cliq.webhookSecret to a high-entropy shared secret (preferably as a SecretRef — run `openclaw secrets apply`), and configure the Deluge bot handler to send it in the x-cliq-webhook-secret header.",
    });
  }

  const allowFrom = asStringArray(section.allowFrom);
  if (isWildcardAllowFrom(allowFrom)) {
    findings.push({
      checkId: "channels.cliq.allow_from.wildcard",
      severity: "critical",
      title: "Cliq allowFrom contains a wildcard",
      detail:
        'channels.cliq.allowFrom contains "*". Under dmPolicy "open" this is the default-allow footgun; under dmPolicy "allowlist" it silently makes the allowlist a no-op. Any Cliq user can drive the agent (issue commands, run tools, read sessions).',
      remediation:
        'Replace "*" with explicit sender ids (Zoho user ids / bot unique names), or switch to dmPolicy "pairing" and approve senders via the pairing flow.',
    });
  }

  const dmPolicy =
    typeof section.dmPolicy === "string" ? section.dmPolicy : "allowlist";
  if (dmPolicy === "open") {
    findings.push({
      checkId: "channels.cliq.dm_policy.open",
      severity: "warn",
      title: "Cliq DM policy is open",
      detail:
        'channels.cliq.dmPolicy is "open". Any Cliq user can DM the bot and drive the agent without an allowlist. This is an explicit operator opt-in — pair it with a tight allowFrom, or switch to "allowlist" / "pairing" if the bot is reachable from outside a trusted workspace.',
      remediation:
        'Set channels.cliq.dmPolicy to "allowlist" and populate allowFrom with known sender ids, or to "pairing" to approve senders interactively. Keep "open" only for workspace-internal bots with a hardened allowFrom.',
    });
  }

  const defaults = readSecretsDefaults(params.cfg);
  const plaintextSecrets: string[] = [];
  if (classifySecretField(section.clientSecret, defaults) === "plaintext") {
    plaintextSecrets.push("clientSecret");
  }
  if (classifySecretField(section.webhookSecret, defaults) === "plaintext") {
    plaintextSecrets.push("webhookSecret");
  }
  if (classifySecretField(section.refreshToken, defaults) === "plaintext") {
    plaintextSecrets.push("refreshToken");
  }
  if (plaintextSecrets.length > 0) {
    findings.push({
      checkId: "channels.cliq.secrets.plaintext",
      severity: "warn",
      title: "Cliq secret fields are stored as plaintext in config",
      detail: `The following Cliq secret field${
        plaintextSecrets.length > 1 ? "s are" : " is"
      } stored as a literal string in openclaw.json: ${plaintextSecrets.join(
        ", ",
      )}. A literal secret is committed to disk (and to source control if the config is tracked), and is exposed to anyone who can read the config file.`,
      remediation:
        "Run `openclaw secrets apply` to rewrite each plaintext secret into an env / file / exec-backed SecretRef, or set them as SecretRef objects manually (see `openclaw secrets --help`).",
    });
  }

  return findings;
}

/**
 * The SDK-shaped collector registered with the gateway. Adapts the SDK's
 * `OpenClawPluginSecurityAuditContext` (`{ config, sourceConfig, env,
 * stateDir, configPath }`) to our pure `collectCliqSecurityAuditFindings`.
 *
 * The Cliq checks are pure config reads (no network, no env resolution), so
 * `sourceConfig` (the pre-resolve config) and `config` (the resolved config)
 * produce identical findings; we read `config` to match what the running
 * gateway sees. Never throws — a thrown collector would abort the entire
 * security sweep.
 */
export function cliqSecurityAuditCollector(ctx: {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  configPath?: string;
}): CliqSecurityAuditFinding[] {
  try {
    return collectCliqSecurityAuditFindings({ cfg: ctx.config });
  } catch {
    return [];
  }
}
