import { describe, it, expect, vi } from "vitest";
import { paginateList } from "./pagination.js";

/** Build a fake `fetchPage` from a scripted sequence of pages. */
function makeFetchPage<T>(
  pages: { items: T[]; nextToken?: string }[],
): {
  fn: (args: { nextToken?: string; from: number; limit: number }) => Promise<{
    items: T[];
    nextToken?: string;
  }>;
  calls: { nextToken?: string; from: number; limit: number }[];
} {
  const calls: { nextToken?: string; from: number; limit: number }[] = [];
  let i = 0;
  const fn = vi.fn(async (args: { nextToken?: string; from: number; limit: number }) => {
    calls.push({ ...args });
    const page = pages[Math.min(i, pages.length - 1)];
    i++;
    return page;
  });
  return { fn, calls };
}

describe("paginateList — cursor mode (next_token)", () => {
  it("follows next_token cursors until absent, then stops", async () => {
    const { fn, calls } = makeFetchPage([
      { items: ["a", "b"], nextToken: "cur-1" },
      { items: ["c", "d"], nextToken: "cur-2" },
      { items: ["e"] }, // last page: no next_token
    ]);
    const out = await paginateList(fn, { maxItems: 100, pageSize: 10 });
    expect(out).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls).toHaveLength(3);
    // First call: no cursor. Second: cur-1. Third: cur-2.
    expect(calls[0].nextToken).toBeUndefined();
    expect(calls[1].nextToken).toBe("cur-1");
    expect(calls[2].nextToken).toBe("cur-2");
  });

  it("stops at maxItems even when more pages are available", async () => {
    const { fn, calls } = makeFetchPage([
      { items: ["a", "b"], nextToken: "cur-1" },
      { items: ["c", "d"], nextToken: "cur-2" },
    ]);
    const out = await paginateList(fn, { maxItems: 3, pageSize: 10 });
    expect(out).toEqual(["a", "b", "c"]);
    // Only one fetch needed — the first page (2 items) plus maxItems cap
    // means we fetch a second page to get the 3rd item, then stop.
    expect(calls).toHaveLength(2);
  });

  it("stops at maxItems exactly at a page boundary without an extra fetch", async () => {
    const { fn, calls } = makeFetchPage([
      { items: ["a", "b"], nextToken: "cur-1" },
      { items: ["c", "d"], nextToken: "cur-2" },
    ]);
    const out = await paginateList(fn, { maxItems: 2, pageSize: 10 });
    expect(out).toEqual(["a", "b"]);
    expect(calls).toHaveLength(1);
  });
});

describe("paginateList — offset mode (no next_token)", () => {
  it("paginates via from/limit and stops on a non-full page", async () => {
    const pages = [
      { items: Array.from({ length: 10 }, (_, i) => `u${i}`) },
      { items: Array.from({ length: 10 }, (_, i) => `u${10 + i}`) },
      { items: ["u20"] }, // only 1 < limit → last page
    ];
    const { fn, calls } = makeFetchPage(pages);
    const out = await paginateList(fn, { maxItems: 100, pageSize: 10 });
    expect(out).toHaveLength(21);
    expect(calls).toHaveLength(3);
    // Offset advances by the page size each call (no cursors).
    expect(calls[0].from).toBe(0);
    expect(calls[1].from).toBe(10);
    expect(calls[2].from).toBe(20);
    expect(calls.every((c) => c.nextToken === undefined)).toBe(true);
  });

  it("stops immediately on an empty first page", async () => {
    const { fn, calls } = makeFetchPage([{ items: [] }]);
    const out = await paginateList(fn, { maxItems: 100, pageSize: 10 });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("stops at maxItems in offset mode without fetching a partial extra page", async () => {
    // maxItems=10, pageSize=10, first page returns exactly 10 (full) but
    // out.length >= maxItems → no second fetch.
    const pages = [{ items: Array.from({ length: 10 }, (_, i) => `u${i}`) }];
    const { fn, calls } = makeFetchPage(pages);
    const out = await paginateList(fn, { maxItems: 10, pageSize: 10 });
    expect(out).toHaveLength(10);
    expect(calls).toHaveLength(1);
  });
});

describe("paginateList — mixed mode (cursor then offset)", () => {
  it("follows a cursor then resumes offset pagination when it disappears", async () => {
    const pages = [
      { items: ["a", "b"], nextToken: "cur-1" }, // cursor page
      { items: ["c", "d"], nextToken: "cur-2" }, // cursor page
      { items: ["e", "f"] }, // full page, no cursor → offset continues
      { items: ["g"] }, // non-full → last page
    ];
    const { fn, calls } = makeFetchPage(pages);
    const out = await paginateList(fn, { maxItems: 100, pageSize: 2 });
    expect(out).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(calls).toHaveLength(4);
    // First two calls carry the cursor; after it drops, offset advances.
    expect(calls[0].nextToken).toBeUndefined();
    expect(calls[1].nextToken).toBe("cur-1");
    expect(calls[2].nextToken).toBe("cur-2");
    expect(calls[3].nextToken).toBeUndefined();
    // `from` is kept roughly in sync even during cursor mode.
    expect(calls[2].from).toBe(4);
    expect(calls[3].from).toBe(6);
  });
});

describe("paginateList — clamping", () => {
  it("clamps pageSize to [1, 200]", async () => {
    // Use a large maxItems so the requested limit reflects the pageSize clamp
    // (limit = min(pageSize, maxItems - collected); with maxItems huge, limit
    // equals the clamped pageSize).
    const { fn, calls } = makeFetchPage([{ items: ["a"] }]);
    await paginateList(fn, { maxItems: 10_000, pageSize: 9999 });
    expect(calls[0].limit).toBe(200);
    const { fn: fn2, calls: calls2 } = makeFetchPage([{ items: ["a"] }]);
    await paginateList(fn2, { maxItems: 10_000, pageSize: 0 });
    expect(calls2[0].limit).toBe(1);
  });

  it("treats maxItems=0 as collect-nothing (no fetches)", async () => {
    const { fn, calls } = makeFetchPage([{ items: ["a"] }]);
    const out = await paginateList(fn, { maxItems: 0, pageSize: 10 });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
