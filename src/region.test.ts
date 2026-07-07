import { describe, it, expect } from "vitest";
import {
  CLIQ_DATA_CENTERS,
  CLIQ_DEFAULT_DC_ID,
  CLIQ_DATA_CENTER_HINT,
  appendCliqDataCenterHint,
  findCliqDataCenterById,
  findCliqDataCenterByApiBase,
  findCliqDataCenterByOauthBase,
  findCliqDataCenterByApiDomain,
  getDefaultCliqDataCenter,
} from "./region.js";

describe("CLIQ_DATA_CENTERS catalog", () => {
  it("lists EU first (plugin default) with a stable id set", () => {
    expect(CLIQ_DATA_CENTERS[0].id).toBe("eu");
    expect(CLIQ_DEFAULT_DC_ID).toBe("eu");
    const ids = CLIQ_DATA_CENTERS.map((dc) => dc.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "eu",
        "us",
        "in",
        "au",
        "jp",
        "ca",
        "sa",
        "cn",
      ]),
    );
  });

  it("every DC has matching oauthBase + apiBase from the README table", () => {
    const byId = new Map(CLIQ_DATA_CENTERS.map((dc) => [dc.id, dc]));
    expect(byId.get("eu")).toEqual({
      id: "eu",
      label: expect.any(String),
      oauthBase: "https://accounts.zoho.eu",
      apiBase: "https://cliq.zoho.eu",
      consoleUrl: "https://api-console.zoho.eu",
      apiDomainHost: "www.zohoapis.eu",
    });
    expect(byId.get("us")?.oauthBase).toBe("https://accounts.zoho.com");
    expect(byId.get("us")?.apiBase).toBe("https://cliq.zoho.com");
    expect(byId.get("ca")?.oauthBase).toBe("https://accounts.zohocloud.ca");
    expect(byId.get("ca")?.apiBase).toBe("https://cliq.zohocloud.ca");
    expect(byId.get("cn")?.apiBase).toBe("https://cliq.zoho.com.cn");
  });
});

describe("getDefaultCliqDataCenter", () => {
  it("returns EU", () => {
    expect(getDefaultCliqDataCenter().id).toBe("eu");
  });
});

describe("findCliqDataCenterById", () => {
  it("matches case-insensitively", () => {
    expect(findCliqDataCenterById("US")?.id).toBe("us");
    expect(findCliqDataCenterById("eu")?.id).toBe("eu");
  });

  it("returns undefined for an unknown id", () => {
    expect(findCliqDataCenterById("zz")).toBeUndefined();
  });
});

describe("findCliqDataCenterByApiBase", () => {
  it("matches ignoring scheme + trailing slash + case", () => {
    expect(
      findCliqDataCenterByApiBase("https://cliq.zoho.com/")?.id,
    ).toBe("us");
    expect(findCliqDataCenterByApiBase("CLIQ.ZOHO.IN")?.id).toBe("in");
  });

  it("returns undefined for a non-Cliq host", () => {
    expect(
      findCliqDataCenterByApiBase("https://www.zohoapis.com"),
    ).toBeUndefined();
    expect(findCliqDataCenterByApiBase("")).toBeUndefined();
  });
});

describe("findCliqDataCenterByOauthBase", () => {
  it("matches by accounts host", () => {
    expect(
      findCliqDataCenterByOauthBase("https://accounts.zoho.jp")?.id,
    ).toBe("jp");
  });
});

describe("findCliqDataCenterByApiDomain (issue #46)", () => {
  it("maps the Zoho `api_domain` (zohoapis host) back to the Cliq DC", () => {
    expect(
      findCliqDataCenterByApiDomain("https://www.zohoapis.com")?.id,
    ).toBe("us");
    expect(
      findCliqDataCenterByApiDomain("https://www.zohoapis.eu")?.id,
    ).toBe("eu");
    expect(
      findCliqDataCenterByApiDomain("https://www.zohoapis.com.au")?.id,
    ).toBe("au");
    expect(
      findCliqDataCenterByApiDomain("https://www.zohoapis.ca")?.id,
    ).toBe("ca");
  });

  it("tolerates a trailing slash / path", () => {
    expect(
      findCliqDataCenterByApiDomain("https://www.zohoapis.in/")?.id,
    ).toBe("in");
    expect(
      findCliqDataCenterByApiDomain("https://www.zohoapis.in/some/path")?.id,
    ).toBe("in");
  });

  it("returns undefined for the raw `zohoapis` host of an unknown region", () => {
    expect(
      findCliqDataCenterByApiDomain("https://www.zohoapis.example"),
    ).toBeUndefined();
  });

  it("returns undefined for empty / non-string input", () => {
    expect(findCliqDataCenterByApiDomain(undefined)).toBeUndefined();
    expect(findCliqDataCenterByApiDomain("")).toBeUndefined();
    expect(findCliqDataCenterByApiDomain(null)).toBeUndefined();
  });
});

describe("appendCliqDataCenterHint", () => {
  it("appends the hint for an auth-failure body", () => {
    const out = appendCliqDataCenterHint('{"error":"invalid_client"}');
    expect(out).toContain(CLIQ_DATA_CENTER_HINT);
    expect(out.startsWith(" — ")).toBe(true);
  });

  it("appends the hint for oauthtoken_scope_invalid", () => {
    expect(
      appendCliqDataCenterHint('{"code":"oauthtoken_scope_invalid"}'),
    ).toContain(CLIQ_DATA_CENTER_HINT);
  });

  it("returns empty for a non-auth failure body", () => {
    expect(appendCliqDataCenterHint('{"error":"rate_limit_exceeded"}')).toBe("");
    expect(appendCliqDataCenterHint("")).toBe("");
  });

  it("does not duplicate the hint when the body already contains it", () => {
    const body = `invalid_client — ${CLIQ_DATA_CENTER_HINT}`;
    expect(appendCliqDataCenterHint(body)).toBe("");
  });

  it("appends the hint for a v3-envelope 401 (invalid AuthToken) (issue #67)", () => {
    expect(
      appendCliqDataCenterHint(
        JSON.stringify({
          message: "Request was rejected because of invalid AuthToken.",
        }),
      ),
    ).toContain(CLIQ_DATA_CENTER_HINT);
  });

  it("appends the hint for a v3-envelope 403 (not enough permission) (issue #67)", () => {
    expect(
      appendCliqDataCenterHint(
        JSON.stringify({
          message:
            "The user does not have enough permission to access the resource.",
        }),
      ),
    ).toContain(CLIQ_DATA_CENTER_HINT);
  });

  it("returns empty for a v3-envelope non-auth failure", () => {
    expect(
      appendCliqDataCenterHint(
        JSON.stringify({ message: "Too many requests within a certain time frame." }),
      ),
    ).toBe("");
  });
});
