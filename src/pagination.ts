/**
 * v3-style `next_token` cursor pagination helper.
 *
 * v3 standardizes ALL list endpoints on a two-token model: `next_token` for
 * paging and `sync_token` for incremental sync (v2 used six different tokens
 * — `next_token`, `sync_token`, `next_set_token`, `start_token`,
 * `next_search_token`, `page_number`). The response body carries the cursor;
 * pass it back as a `next_token` query param on the next request. When
 * `next_token` is absent from the response, the last page has been reached.
 *
 * This helper drives a paginated endpoint to completion (or `maxItems`),
 * preferring `next_token` when the response provides one and falling back to
 * `from`/`limit` offset pagination for v2 endpoints that don't return a
 * cursor. It is the single pagination primitive the client's list methods
 * (`listUsers`, `listChannels`) and the future v3 CRUD list endpoints
 * (Phase 4) build on — so the directory list calls are already
 * forward-compatible with v3's `next_token` model even though they stay on
 * the v2 `/users` / `/channels` paths today (v3 has no org-directory
 * equivalent — see docs/learnings/094).
 *
 * Ref: <https://www.zoho.com/cliq/help/restapi/v3/pagination/>.
 */

/** A single page of results from a paginated list endpoint. */
export interface PaginatePageResult<T> {
  /** The records on this page (may be fewer than the requested `limit`). */
  items: T[];
  /**
   * Opaque cursor for the next page, when the endpoint supports cursor
   * pagination. Absent when there are no more pages (last page) OR when the
   * endpoint is offset-only (v2 endpoints that don't return a cursor).
   */
  nextToken?: string;
}

/** Options controlling how many records to collect and the page size. */
export interface PaginateOptions {
  /** Maximum total records to collect across all pages. */
  maxItems: number;
  /**
   * Page size requested from the API per call. Clamped to `[1, 200]` (Cliq's
   * max page size for the directory endpoints).
   */
  pageSize: number;
}

/**
 * Drive a paginated list endpoint to completion (or `maxItems`), following
 * `next_token` cursors when present and falling back to `from`/`limit`
 * offset pagination otherwise.
 *
 * The `fetchPage` callback receives the current cursor (`nextToken`, when in
 * cursor mode) and the current offset (`from`, when in offset mode) plus the
 * `limit` to request. It returns the page's items and, when available, the
 * next cursor. The helper stops when:
 *  - an empty page is returned,
 *  - a non-cursor page carries fewer items than requested (the last page),
 *  - or `maxItems` records have been collected.
 *
 * Mixed-mode endpoints (a v2 endpoint that returns `next_token` on some pages
 * but not others) are handled gracefully: the helper follows the cursor while
 * it is present and resumes offset pagination once it disappears.
 */
export async function paginateList<T>(
  fetchPage: (args: {
    nextToken?: string;
    from: number;
    limit: number;
  }) => Promise<PaginatePageResult<T>>,
  opts: PaginateOptions,
): Promise<T[]> {
  const maxItems = Math.max(0, opts.maxItems);
  const pageSize = Math.max(1, Math.min(opts.pageSize, 200));
  const out: T[] = [];
  let nextToken: string | undefined;
  let from = 0;
  while (out.length < maxItems) {
    const limit = Math.min(pageSize, maxItems - out.length);
    const page = await fetchPage({ nextToken, from, limit });
    if (page.items.length === 0) break;
    for (const item of page.items) {
      if (out.length >= maxItems) break;
      out.push(item);
    }
    if (out.length >= maxItems) break;
    if (page.nextToken) {
      // Cursor mode: follow the opaque token. `from` is irrelevant to the
      // endpoint in this mode but keep it roughly in sync in case a later
      // page drops the cursor (mixed-mode endpoint).
      nextToken = page.nextToken;
      from += page.items.length;
      continue;
    }
    // Offset mode (no cursor returned). A non-full page is the last page.
    if (page.items.length < limit) break;
    nextToken = undefined;
    from += page.items.length;
  }
  return out;
}
