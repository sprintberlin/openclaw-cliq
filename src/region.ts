/**
 * Zoho Cliq data-center (region) catalog + lookup helpers.
 *
 * Zoho stores each account in a single regional data center, and the OAuth +
 * REST API host differs per region (accounts are DC-exclusive — a `.eu`
 * account cannot authenticate against `.com`). The plugin defaults to the EU
 * endpoints; for any other region the operator sets `oauthBase` + `apiBase`.
 *
 * This module is the single source of truth for the region→endpoints map. It
 * is consumed by:
 *  - the setup wizard (the data-center `select` prompt),
 *  - the client (auto-correcting `apiBase` from a token response's
 *    `api_domain` field — Zoho returns the *general* API host, which we map
 *    back to the matching Cliq host; the raw `zohoapis` host must NEVER be
 *    used as `apiBase` because it is not the Cliq host),
 *  - the doctor (validating that `oauthBase` + `apiBase` agree on a region).
 *
 * Reference: https://www.zoho.com/accounts/protocol/oauth/multi-dc.html
 */

import { parseCliqErrorBody } from "./cliq-error.js";

export interface CliqDataCenter {
  /** Stable lowercase id (`eu`, `us`, `in`, …). */
  readonly id: string;
  /** Human label for the setup-wizard select. */
  readonly label: string;
  /** OAuth base, e.g. `https://accounts.zoho.eu`. */
  readonly oauthBase: string;
  /** Cliq REST API base, e.g. `https://cliq.zoho.eu`. */
  readonly apiBase: string;
  /** Zoho API Console URL for the region's self-client setup. */
  readonly consoleUrl: string;
  /**
   * Lowercased hostname Zoho returns in the token response `api_domain`
   * field (the *general* API host, NOT the Cliq host). Used to recognize
   * which region a token was minted for so `apiBase` can be auto-corrected
   * when it disagrees. e.g. `www.zohoapis.eu` → EU.
   */
  readonly apiDomainHost: string;
}

/** The plugin-default region (preserved for backward compatibility). */
export const CLIQ_DEFAULT_DC_ID = "eu";

/**
 * The full region→endpoints catalog. Mirror the README "Data centers" table.
 * Order matters: the setup-wizard select renders options in this order, and EU
 * is first so the default lands on the plugin's historical default region.
 */
export const CLIQ_DATA_CENTERS: readonly CliqDataCenter[] = [
  {
    id: "eu",
    label: "Europe (default)",
    oauthBase: "https://accounts.zoho.eu",
    apiBase: "https://cliq.zoho.eu",
    consoleUrl: "https://api-console.zoho.eu",
    apiDomainHost: "www.zohoapis.eu",
  },
  {
    id: "us",
    label: "United States",
    oauthBase: "https://accounts.zoho.com",
    apiBase: "https://cliq.zoho.com",
    consoleUrl: "https://api-console.zoho.com",
    apiDomainHost: "www.zohoapis.com",
  },
  {
    id: "in",
    label: "India",
    oauthBase: "https://accounts.zoho.in",
    apiBase: "https://cliq.zoho.in",
    consoleUrl: "https://api-console.zoho.in",
    apiDomainHost: "www.zohoapis.in",
  },
  {
    id: "au",
    label: "Australia",
    oauthBase: "https://accounts.zoho.com.au",
    apiBase: "https://cliq.zoho.com.au",
    consoleUrl: "https://api-console.zoho.com.au",
    apiDomainHost: "www.zohoapis.com.au",
  },
  {
    id: "jp",
    label: "Japan",
    oauthBase: "https://accounts.zoho.jp",
    apiBase: "https://cliq.zoho.jp",
    consoleUrl: "https://api-console.zoho.jp",
    apiDomainHost: "www.zohoapis.jp",
  },
  {
    id: "ca",
    label: "Canada",
    oauthBase: "https://accounts.zohocloud.ca",
    apiBase: "https://cliq.zohocloud.ca",
    consoleUrl: "https://api-console.zohocloud.ca",
    apiDomainHost: "www.zohoapis.ca",
  },
  {
    id: "sa",
    label: "Saudi Arabia",
    oauthBase: "https://accounts.zoho.sa",
    apiBase: "https://cliq.zoho.sa",
    consoleUrl: "https://api-console.zoho.sa",
    apiDomainHost: "www.zohoapis.sa",
  },
  {
    id: "cn",
    label: "China",
    oauthBase: "https://accounts.zoho.com.cn",
    apiBase: "https://cliq.zoho.com.cn",
    consoleUrl: "https://api-console.zoho.com.cn",
    apiDomainHost: "www.zohoapis.com.cn",
  },
];

/** Plugin-default DC (EU). */
export function getDefaultCliqDataCenter(): CliqDataCenter {
  return CLIQ_DATA_CENTERS[0];
}

/** Look up a DC by its stable id (case-insensitive). */
export function findCliqDataCenterById(id: string): CliqDataCenter | undefined {
  const needle = id.trim().toLowerCase();
  return CLIQ_DATA_CENTERS.find((dc) => dc.id === needle);
}

/**
 * Normalize a URL-ish string for comparison: lowercase, strip the scheme, strip
 * a trailing slash. Returns `undefined` for empty / non-string input. Used so
 * `https://cliq.zoho.eu/` and `cliq.zoho.eu` compare equal.
 */
function normalizeHostBase(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let v = value.trim().toLowerCase();
  if (!v) return undefined;
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/\/+$/, "");
  return v || undefined;
}

/** Look up a DC by its `apiBase` (normalized; trailing slash / scheme ignored). */
export function findCliqDataCenterByApiBase(apiBase: string): CliqDataCenter | undefined {
  const needle = normalizeHostBase(apiBase);
  if (!needle) return undefined;
  return CLIQ_DATA_CENTERS.find((dc) => normalizeHostBase(dc.apiBase) === needle);
}

/** Look up a DC by its `oauthBase` (normalized). */
export function findCliqDataCenterByOauthBase(
  oauthBase: string,
): CliqDataCenter | undefined {
  const needle = normalizeHostBase(oauthBase);
  if (!needle) return undefined;
  return CLIQ_DATA_CENTERS.find(
    (dc) => normalizeHostBase(dc.oauthBase) === needle,
  );
}

/**
 * Parse the `api_domain` field Zoho returns in token responses and map it back
 * to the matching Cliq data center. The `api_domain` is the *general* API host
 * (e.g. `https://www.zohoapis.eu`), NOT the Cliq host — this function extracts
 * the hostname and looks it up against each DC's `apiDomainHost`. Returns
 * `undefined` when the value does not match any known region (so the caller
 * can leave `apiBase` unchanged rather than guessing).
 */
export function findCliqDataCenterByApiDomain(
  apiDomain: string | undefined | null,
): CliqDataCenter | undefined {
  if (typeof apiDomain !== "string") return undefined;
  let host = apiDomain.trim().toLowerCase();
  if (!host) return undefined;
  host = host.replace(/^https?:\/\//, "");
  host = host.replace(/\/+$/, "");
  // Strip any port / path remainder.
  host = host.split("/")[0];
  return CLIQ_DATA_CENTERS.find((dc) => dc.apiDomainHost === host);
}

/**
 * The data-center hint appended to Zoho OAuth / API auth failures so operators
 * get a pointer to the most likely cause when a non-EU account defaults to the
 * EU endpoints. Exported so tests + the client + doctor + send-retry share one
 * string.
 */
export const CLIQ_DATA_CENTER_HINT =
  "verify your Zoho data center — set oauthBase + apiBase to match (see README → Data centers)";

/**
 * Patterns that mark a Zoho OAuth / API response as an *auth* failure likely
 * caused by a wrong data center — a non-EU account hitting the EU endpoints
 * (or vice versa). When the response body matches one of these, a data-center
 * hint is appended to the thrown error so the operator gets a pointer to the
 * most likely cause instead of an opaque Zoho error.
 */
const CLIQ_AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /invalid_client/i,
  /oauthtoken_scope_invalid/i,
  /invalid_token/i,
  /unauthorized/i,
  /access\s*denied/i,
  // v3 error-envelope messages (the v3 Errors docs use phrasings like
  // "Request was rejected because of invalid AuthToken." for 401 and
  // "The user does not have enough permission …" for 403). Without these,
  // a v3 endpoint's auth failure would NOT trigger the data-center hint
  // because the substrings differ from the v2 `invalid_token` /
  // `unauthorized` tokens.
  /invalid\s+authtoken/i,
  /not\s+enough\s+permission/i,
  /does\s+not\s+have\s+enough\s+permission/i,
];

/**
 * Build the trailing data-center hint to append to a Zoho auth-failure error
 * message. Returns `""` when the body does not look like an auth failure (so
 * unrelated errors stay clean) or when the body already contains the hint
 * (so it is never duplicated).
 *
 * Both the raw body and the v3 envelope's extracted `message` are tested
 * against the auth-failure patterns, so a v3 JSON `{"message":"…invalid
 * AuthToken…"}` triggers the hint just like a v2 `invalid_client` body.
 */
export function appendCliqDataCenterHint(body: string): string {
  if (!body) return "";
  if (body.includes(CLIQ_DATA_CENTER_HINT)) return "";
  const parsed = parseCliqErrorBody(body);
  const haystacks = parsed.isV3Envelope ? [parsed.message, body] : [body];
  const looksLikeAuthFailure = haystacks.some((re_body) =>
    CLIQ_AUTH_FAILURE_PATTERNS.some((re) => re.test(re_body)),
  );
  if (!looksLikeAuthFailure) return "";
  return ` — ${CLIQ_DATA_CENTER_HINT}`;
}
