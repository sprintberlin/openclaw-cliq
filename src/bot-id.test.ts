import { describe, expect, it, vi } from "vitest";
import {
  createCliqBotIdResolver,
  isCliqInternalBotId,
  resolveCliqInternalBotId,
  type CliqBotIdLister,
} from "./bot-id.js";
import type { CliqBotReadFailure, CliqBotRecord } from "./client.js";

function bot(overrides: Partial<CliqBotRecord> = {}): CliqBotRecord {
  return {
    id: "b-464329000000074001",
    unique_name: "franzi",
    name: "Franzi",
    ...overrides,
  };
}

function lister(
  result: CliqBotRecord[] | CliqBotReadFailure,
): CliqBotIdLister {
  return vi.fn(async () => result);
}

describe("isCliqInternalBotId", () => {
  it("accepts Zoho's documented b-… form", () => {
    expect(isCliqInternalBotId("b-464329000000074001")).toBe(true);
    expect(isCliqInternalBotId("  B-1  ")).toBe(true);
  });

  it("rejects a unique name", () => {
    expect(isCliqInternalBotId("franzi")).toBe(false);
    expect(isCliqInternalBotId("openclaw-bot")).toBe(false);
    expect(isCliqInternalBotId("")).toBe(false);
  });
});

describe("resolveCliqInternalBotId", () => {
  it("resolves a unique name through the bot listing", async () => {
    const listBots = lister([bot(), bot({ id: "b-2", unique_name: "livia" })]);
    const result = await resolveCliqInternalBotId({
      configuredId: "franzi",
      listBots,
    });
    expect(result).toEqual({
      ok: true,
      botId: "b-464329000000074001",
      uniqueName: "franzi",
      cached: false,
    });
    expect(listBots).toHaveBeenCalledTimes(1);
  });

  it("passes an already-internal id through without listing", async () => {
    const listBots = lister([bot()]);
    const result = await resolveCliqInternalBotId({
      configuredId: "b-464329000000074001",
      listBots,
    });
    expect(result).toMatchObject({ ok: true, botId: "b-464329000000074001", cached: false });
    expect(listBots).not.toHaveBeenCalled();
  });

  it("reports no match when the unique name is absent from a complete listing", async () => {
    const result = await resolveCliqInternalBotId({
      configuredId: "franzi",
      listBots: lister([bot({ unique_name: "livia", id: "b-9" })]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("not_found");
    expect(result.reason).toMatch(/unique name/i);
  });

  it("reports an ambiguous unique name instead of picking one", async () => {
    const result = await resolveCliqInternalBotId({
      configuredId: "franzi",
      listBots: lister([
        bot({ id: "b-1" }),
        bot({ id: "b-2" }),
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("ambiguous");
    expect(result.reason).toMatch(/ambiguous|more than one/i);
  });

  it("walks a paginated listing rather than stopping at the first page", async () => {
    const listBots = vi.fn(async () => [
      bot({ id: "b-page-1", unique_name: "other" }),
      bot({ id: "b-464329000000074001", unique_name: "franzi" }),
    ]);
    const result = await resolveCliqInternalBotId({ configuredId: "franzi", listBots });
    expect(result).toMatchObject({ ok: true, botId: "b-464329000000074001" });
  });

  it("does not claim not_found when the listing did not finish", async () => {
    const result = await resolveCliqInternalBotId({
      configuredId: "franzi",
      listBots: lister({
        kind: "http",
        detail: "the bot listing did not complete before the diagnostic item limit",
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("incomplete");
    expect(result.reason).not.toMatch(/does not exist|not found/i);
  });

  it("reports a missing Bots.READ scope without leaking the Zoho body", async () => {
    const sentinel = "SENSITIVE_OAUTH_BODY";
    const result = await resolveCliqInternalBotId({
      configuredId: "franzi",
      listBots: lister({
        kind: "missing_scope",
        detail: `Zoho refused the bot read with HTTP 403; ${sentinel}`,
        status: 403,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("missing_scope");
    expect(result.reason).toContain("ZohoCliq.Bots.READ");
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("redacts a thrown listing error on the failure path", async () => {
    const leaked = '{"webhookSecret":"live-handler-secret","access_token":"tok"}';
    const result = await resolveCliqInternalBotId({
      configuredId: "franzi",
      listBots: async () => {
        throw new Error(`GET /api/v3/bots failed (500): ${leaked}`);
      },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("live-handler-secret");
    expect(JSON.stringify(result)).not.toContain("access_token");
    expect(JSON.stringify(result)).not.toContain(leaked);
  });
});

describe("createCliqBotIdResolver", () => {
  it("caches a successful unique-name resolution for the rest of the run", async () => {
    const listBots = lister([bot()]);
    const resolver = createCliqBotIdResolver(listBots);
    const first = await resolver.resolve("franzi");
    const second = await resolver.resolve("franzi");
    expect(first).toMatchObject({ ok: true, botId: "b-464329000000074001", cached: false });
    expect(second).toMatchObject({ ok: true, botId: "b-464329000000074001", cached: true });
    expect(listBots).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure so a later retry can recover", async () => {
    const listBots = vi
      .fn<CliqBotIdLister>()
      .mockResolvedValueOnce({ kind: "transport", detail: "boom" })
      .mockResolvedValueOnce([bot()]);
    const resolver = createCliqBotIdResolver(listBots);
    expect((await resolver.resolve("franzi")).ok).toBe(false);
    expect(await resolver.resolve("franzi")).toMatchObject({
      ok: true,
      botId: "b-464329000000074001",
    });
    expect(listBots).toHaveBeenCalledTimes(2);
  });
});
