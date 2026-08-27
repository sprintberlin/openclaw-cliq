import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const CLIQ_DEFAULT_DM_SCOPE = "main";
export const CLIQ_RECOMMENDED_DM_SCOPE = "per-channel-peer";
export const CLIQ_MULTI_ACCOUNT_DM_SCOPE = "per-account-channel-peer";

export function readEffectiveDmScope(cfg: OpenClawConfig): string {
  const raw = (cfg as unknown as { session?: { dmScope?: unknown } }).session
    ?.dmScope;
  return typeof raw === "string" && raw.trim()
    ? raw.trim()
    : CLIQ_DEFAULT_DM_SCOPE;
}

export function admitsMultipleDmSenders(
  section: Record<string, unknown> | null | undefined,
): boolean {
  if (!section) return false;
  const policy =
    typeof section.dmPolicy === "string" ? section.dmPolicy : "allowlist";
  if (policy === "disabled") return false;
  if (policy === "open" || policy === "pairing") return true;
  const allowFrom = Array.isArray(section.allowFrom)
    ? section.allowFrom.filter((entry): entry is string => typeof entry === "string")
    : [];
  return allowFrom.some((entry) => entry.trim() === "*") || allowFrom.length > 1;
}

export function hasSharedDmSessionRisk(params: {
  cfg: OpenClawConfig;
  section: Record<string, unknown> | null | undefined;
}): boolean {
  return (
    admitsMultipleDmSenders(params.section) &&
    readEffectiveDmScope(params.cfg) === CLIQ_DEFAULT_DM_SCOPE
  );
}

export const SHARED_DM_SCOPE_WARNING =
  "This Cliq bot may receive DMs from multiple users, but all DMs currently share one OpenClaw session (session.dmScope resolves to main). Conversation context can leak between users, and the shared session's latest delivery route can send a reply to a different channel. Set session.dmScope to per-channel-peer to prevent conversation-context leakage.";
