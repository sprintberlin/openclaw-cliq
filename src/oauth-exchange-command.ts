import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { evaluateCliqScopeSet, FULL_SCOPE_STRING } from "./capabilities.js";
import { appendCliqDataCenterHint } from "./region.js";

export const CLIQ_AUTH_CODE_ENV = "OPENCLAW_CLIQ_AUTH_CODE";

type CliqSection = Record<string, unknown>;

export interface CliqOAuthExchangeCommandOptions {
  cfg: OpenClawConfig;
  code?: string;
  clientId?: string;
  /** Secret input is sourced from an env variable, never an argv option. */
  clientSecret?: string;
  accountId?: string;
  check?: boolean;
}

export interface CliqOAuthExchangeCommandDeps {
  fetch: typeof fetch;
  mutateConfigFile: (
    options: { mutate: (draft: OpenClawConfig) => void; writeOptions: { skipOutputLogs: boolean } },
  ) => Promise<unknown>;
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

const defaultDeps: CliqOAuthExchangeCommandDeps = {
  fetch: globalThis.fetch,
  mutateConfigFile,
  writeLine: (line) => process.stdout.write(`${line}\n`),
  writeError: (line) => process.stderr.write(`${line}\n`),
};

function accountPath(accountId?: string): string {
  return accountId ? `channels.cliq.accounts.${accountId}` : "channels.cliq";
}

function sectionFor(cfg: OpenClawConfig, accountId?: string): CliqSection {
  const root = cfg as unknown as { channels?: { cliq?: CliqSection } };
  const rootSection = root.channels?.cliq ?? {};
  if (!accountId) return rootSection;
  const accounts = rootSection.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return {};
  const section = (accounts as Record<string, unknown>)[accountId];
  return section && typeof section === "object" && !Array.isArray(section)
    ? section as CliqSection
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeOAuthError(body: string, status: number): string {
  let code = "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    code = typeof parsed.error === "string"
      ? parsed.error
      : typeof parsed.code === "string"
        ? parsed.code
        : "";
  } catch {
    // Zoho error envelopes are useful only by code; never echo an arbitrary body.
  }
  if (code === "invalid_code") {
    return "The authorization code is invalid, expired, or already used. Generate a fresh self-client code and retry.";
  }
  return `Zoho OAuth token exchange failed (HTTP ${status}${code ? `, ${code}` : ""}).${appendCliqDataCenterHint(body)}`;
}

interface OAuthSuccess {
  refresh_token?: unknown;
  access_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
}

async function requestToken(params: {
  oauthBase: string;
  clientId: string;
  clientSecret: string;
  grantType: "authorization_code" | "refresh_token";
  codeOrToken: string;
  fetch: typeof fetch;
}): Promise<{ ok: true; data: OAuthSuccess } | { ok: false; error: string }> {
  const url = new URL(`${params.oauthBase.replace(/\/+$/, "")}/oauth/v2/token`);
  url.searchParams.set("grant_type", params.grantType);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("client_secret", params.clientSecret);
  url.searchParams.set(params.grantType === "authorization_code" ? "code" : "refresh_token", params.codeOrToken);
  let response: Response;
  try {
    response = await params.fetch(url, { method: "POST" });
  } catch {
    return { ok: false, error: "Zoho OAuth token exchange could not reach the configured endpoint." };
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) return { ok: false, error: safeOAuthError(body, response.status) };
  try {
    return { ok: true, data: JSON.parse(body) as OAuthSuccess };
  } catch {
    return { ok: false, error: "Zoho OAuth token exchange returned an invalid response." };
  }
}

function grantedScopes(data: OAuthSuccess): string[] {
  return typeof data.scope === "string"
    ? data.scope.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)
    : [];
}

function writeScopeSummary(deps: CliqOAuthExchangeCommandDeps, scope: readonly string[]): void {
  const evaluation = evaluateCliqScopeSet(scope);
  deps.writeLine(`Granted scopes: ${scope.length ? scope.join(", ") : "not reported by Zoho"}.`);
  const missing = FULL_SCOPE_STRING.split(",").filter((value) => !evaluation.granted.includes(value));
  if (missing.length) {
    deps.writeLine(`Warning: the combined Cliq profile is missing ${missing.join(", ")}. Re-consent with the full profile before using those capabilities.`);
  }
}

/**
 * Exchange a single-use Zoho self-client code without ever writing its result
 * to stdout/stderr. Config writes go through the SDK's atomic mutation path.
 */
export async function runCliqOAuthExchangeCommand(
  options: CliqOAuthExchangeCommandOptions,
  deps: CliqOAuthExchangeCommandDeps = defaultDeps,
): Promise<number> {
  const section = sectionFor(options.cfg, options.accountId);
  const clientId = options.clientId?.trim() || stringValue(section.clientId);
  const clientSecret = options.clientSecret?.trim() || stringValue(section.clientSecret);
  const oauthBase = stringValue(section.oauthBase) ?? "https://accounts.zoho.eu";
  const refreshToken = stringValue(section.refreshToken);
  const code = options.code?.trim() || stringValue(process.env[CLIQ_AUTH_CODE_ENV]);

  const missing = [
    !clientId ? "clientId" : undefined,
    !clientSecret ? "clientSecret" : undefined,
    options.check ? (!refreshToken ? "refreshToken" : undefined) : (!code ? `authorization code (stdin or $${CLIQ_AUTH_CODE_ENV})` : undefined),
  ].filter((value): value is string => Boolean(value));
  if (missing.length) {
    deps.writeError(`Missing required inputs: ${missing.join(", ")}.`);
    return 2;
  }

  const result = await requestToken({
    oauthBase,
    clientId: clientId!,
    clientSecret: clientSecret!,
    grantType: options.check ? "refresh_token" : "authorization_code",
    codeOrToken: options.check ? refreshToken! : code!,
    fetch: deps.fetch,
  });
  if (!result.ok) {
    deps.writeError(result.error);
    return 1;
  }

  if (options.check) {
    if (!stringValue(result.data.access_token)) {
      deps.writeError("Zoho OAuth token check returned no access token.");
      return 1;
    }
    deps.writeLine("Refresh-token check succeeded; no config was changed.");
    writeScopeSummary(deps, grantedScopes(result.data));
    return 0;
  }

  const newRefreshToken = stringValue(result.data.refresh_token);
  if (!newRefreshToken) {
    deps.writeError("Zoho OAuth token exchange returned no refresh token.");
    return 1;
  }
  let written = false;
  try {
    await deps.mutateConfigFile({
      writeOptions: { skipOutputLogs: true },
      mutate: (draft) => {
        const root = draft as unknown as { channels?: Record<string, CliqSection> };
        if (!root.channels) root.channels = {};
        if (!options.accountId) {
          const current = root.channels.cliq ?? {};
          root.channels.cliq = { ...current, refreshToken: newRefreshToken };
          written = true;
          return;
        }
        const current = root.channels.cliq ?? {};
        const accounts = current.accounts && typeof current.accounts === "object" && !Array.isArray(current.accounts)
          ? current.accounts as Record<string, CliqSection>
          : {};
        const account = accounts[options.accountId] ?? {};
        root.channels.cliq = {
          ...current,
          accounts: { ...accounts, [options.accountId]: { ...account, refreshToken: newRefreshToken } },
        };
        written = true;
      },
    });
  } catch {
    deps.writeError("Could not atomically write the refresh token; the previous config was left unchanged.");
    return 1;
  }
  if (!written) {
    deps.writeError("The config changed before the refresh token could be written; no config was changed.");
    return 1;
  }
  deps.writeLine(`Refresh token stored in ${accountPath(options.accountId)}.refreshToken.`);
  writeScopeSummary(deps, grantedScopes(result.data));
  deps.writeLine("Restart the OpenClaw gateway so it loads the updated Cliq config.");
  return 0;
}
