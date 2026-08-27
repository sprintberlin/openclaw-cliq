import { describe, expect, it, vi, afterEach } from "vitest";
import { createCliqTestConfig as cfgWith } from "./test-api.js";
import { cliqDirectoryAdapter } from "./directory.js";
import { resolveCliqDirectoryAllowlist } from "./setup-directory.js";

const CONFIGURED = cfgWith({
  clientId: "id",
  clientSecret: "secret",
  botId: "bot",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveCliqDirectoryAllowlist", () => {
  it("resolves a user by email to the canonical Zoho user id", async () => {
    vi.spyOn(cliqDirectoryAdapter, "listPeers" as never).mockResolvedValue([
      { kind: "user", id: "112233", name: "Alice", handle: "alice@example.com" },
    ] as never);
    const resolved = await resolveCliqDirectoryAllowlist({
      cfg: CONFIGURED,
      entries: ["alice@example.com"],
      kind: "user",
    });
    expect(resolved).toEqual([
      { input: "alice@example.com", id: "112233", label: "Alice", resolved: true },
    ]);
  });

  it("resolves a channel to its unique name (the group config key)", async () => {
    vi.spyOn(cliqDirectoryAdapter, "listGroups" as never).mockResolvedValue([
      { kind: "group", id: "CT_1", name: "Dev Team", handle: "dev-team" },
    ] as never);
    const resolved = await resolveCliqDirectoryAllowlist({
      cfg: CONFIGURED,
      entries: ["Dev Team"],
      kind: "group",
    });
    expect(resolved[0]).toMatchObject({ id: "dev-team", resolved: true });
  });

  it("keeps unresolved entries verbatim instead of widening or dropping them", async () => {
    vi.spyOn(cliqDirectoryAdapter, "listPeers" as never).mockResolvedValue([] as never);
    const resolved = await resolveCliqDirectoryAllowlist({
      cfg: CONFIGURED,
      entries: ["unknown-person"],
      kind: "user",
    });
    expect(resolved).toEqual([
      { input: "unknown-person", id: "unknown-person", resolved: false },
    ]);
  });

  it("degrades to unresolved when the directory call fails", async () => {
    vi.spyOn(cliqDirectoryAdapter, "listPeers" as never).mockRejectedValue(
      new Error("scope missing") as never,
    );
    const resolved = await resolveCliqDirectoryAllowlist({
      cfg: CONFIGURED,
      entries: ["alice@example.com"],
      kind: "user",
    });
    expect(resolved[0].resolved).toBe(false);
  });
});
