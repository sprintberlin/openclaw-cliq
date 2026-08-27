import type { CliqBotReadFailure, CliqBotRecord } from "./client.js";
import { isCliqBotReadFailure } from "./client.js";

export type CliqBotIdLister = (
  maxItems?: number,
) => Promise<CliqBotRecord[] | CliqBotReadFailure>;

export type CliqBotIdResolution =
  | {
      ok: true;
      botId: string;
      uniqueName?: string;
      cached: boolean;
    }
  | {
      ok: false;
      kind:
        | "missing"
        | "not_found"
        | "ambiguous"
        | "missing_scope"
        | "incomplete"
        | "api_failure";
      reason: string;
    };

export interface CliqBotIdResolver {
  resolve(configuredId: string): Promise<CliqBotIdResolution>;
}

export function isCliqInternalBotId(value: string): boolean {
  return /^b-\d+$/i.test(value.trim());
}

function failureResult(failure: CliqBotReadFailure): CliqBotIdResolution {
  if (failure.kind === "missing_scope") {
    return {
      ok: false,
      kind: "missing_scope",
      reason: "the bot id is unknown because ZohoCliq.Bots.READ is unavailable or was not consented",
    };
  }
  if (
    failure.kind === "http" &&
    /did not complete|item limit|incomplete/i.test(failure.detail)
  ) {
    return {
      ok: false,
      kind: "incomplete",
      reason: "the bot id is unknown because the paginated bot listing did not complete",
    };
  }
  return {
    ok: false,
    kind: "api_failure",
    reason: failure.status
      ? `the bot id is unknown because Zoho answered HTTP ${failure.status}`
      : "the bot id is unknown because the bot listing failed",
  };
}

export async function resolveCliqInternalBotId(params: {
  configuredId: string;
  listBots: CliqBotIdLister;
}): Promise<CliqBotIdResolution> {
  const configuredId = params.configuredId.trim();
  if (!configuredId) {
    return { ok: false, kind: "missing", reason: "no bot unique name or internal id is configured" };
  }
  if (isCliqInternalBotId(configuredId)) {
    return { ok: true, botId: configuredId, cached: false };
  }
  let listed: CliqBotRecord[] | CliqBotReadFailure;
  try {
    listed = await params.listBots();
  } catch {
    return {
      ok: false,
      kind: "api_failure",
      reason: "the bot id is unknown because the bot listing threw an unexpected error",
    };
  }
  if (isCliqBotReadFailure(listed)) return failureResult(listed);
  const matches = listed.filter(
    (record) => record.unique_name?.trim().toLowerCase() === configuredId.toLowerCase(),
  );
  if (matches.length === 0) {
    return {
      ok: false,
      kind: "not_found",
      reason: `no bot with unique name "${configuredId}" was present in the complete Zoho bot listing`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      kind: "ambiguous",
      reason: `more than one bot has unique name "${configuredId}"; the internal bot id is ambiguous`,
    };
  }
  const botId = matches[0]?.id?.trim();
  if (!botId || !isCliqInternalBotId(botId)) {
    return {
      ok: false,
      kind: "api_failure",
      reason: "Zoho matched the unique name but returned no valid internal b-… bot id",
    };
  }
  return {
    ok: true,
    botId,
    uniqueName: matches[0]?.unique_name?.trim() || configuredId,
    cached: false,
  };
}

export function createCliqBotIdResolver(listBots: CliqBotIdLister): CliqBotIdResolver {
  const cache = new Map<string, Extract<CliqBotIdResolution, { ok: true }>>();
  return {
    async resolve(configuredId: string): Promise<CliqBotIdResolution> {
      const key = configuredId.trim().toLowerCase();
      const cached = cache.get(key);
      if (cached) return { ...cached, cached: true };
      const result = await resolveCliqInternalBotId({ configuredId, listBots });
      if (result.ok) cache.set(key, result);
      return result;
    },
  };
}
