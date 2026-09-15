import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliqClient,
  isAllowedCliqAttachmentPath,
  redactCliqAttachmentPath,
} from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function installFetch() {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url);
    if (url.pathname === "/oauth/v2/token") {
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  }));
  return calls;
}

describe("CliqClient.downloadAttachmentUrl", () => {
  it.each([
    "/api/v2/attachments/download?signature=opaque",
    "/api/attachments/download?signature=opaque",
    "/api/v3/files/f-1?signature=opaque",
    "/company/20000000000/v2/attachments/attachment_example_0000000000000000000000000000000000000000000000000000000000000001",
  ])("downloads a same-origin Cliq attachment URL %s", async (path) => {
    const calls = installFetch();
    const client = new CliqClient("id", "secret", "bot");
    const result = await client.downloadAttachmentUrl(path);
    expect(result.contentType).toBe("audio/wav");
    expect(calls.at(-1)?.pathname).toBe(new URL(path, "https://cliq.zoho.eu").pathname);
    if (path.includes("signature=")) {
      expect(calls.at(-1)?.searchParams.get("signature")).toBe("opaque");
    }
  });

  it("accepts only the exact live company attachment shape and redacts opaque ids", () => {
    expect(isAllowedCliqAttachmentPath(
      "/company/20000000000/v2/attachments/attachment_example_0001",
    )).toBe(true);
    expect(isAllowedCliqAttachmentPath(
      "/company/acme/v2/attachments/attachment_example_0001",
    )).toBe(false);
    expect(isAllowedCliqAttachmentPath(
      "/company/20000000000/v2/users/attachment_example_0001",
    )).toBe(false);
    expect(redactCliqAttachmentPath(
      "/company/20000000000/v2/attachments/attachment_example_0001",
    )).toBe("/company/20000000000/v2/attachments/attachment_e…");
  });

  it.each([
    "http://cliq.zoho.eu/api/v2/files/f-1",
    "https://example.invalid/api/v2/files/f-1",
    "https://cliq.zoho.eu/private/download/f-1",
    "https://cliq.zoho.eu/company/acme/v2/attachments/f-1",
    "https://cliq.zoho.eu/company/20000000000/v2/users/f-1",
  ])("rejects unsafe or non-attachment URL %s before any fetch", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new CliqClient("id", "secret", "bot");
    await expect(client.downloadAttachmentUrl(url)).rejects.toThrow(
      /configured Cliq API origin|Cliq API/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
