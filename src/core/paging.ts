// Pagination math: how many pages a row count needs, clamping a requested
// page into range, the row-index slice a page covers, which page a given
// row index falls on, and normalizing a (possibly stored, possibly invalid)
// page size. Pure module, no vscode/DOM — mirrors the rest of src/core.

export const PAGE_SIZES = [25, 50, 100, 200, 500] as const;
export const DEFAULT_PAGE_SIZE = 100;

/** Number of pages for `total` rows at `size` rows per page. Always >= 1,
 * even for zero rows, so a page selector always has something to show. */
export function pageCount(total: number, size: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(size) || size <= 0 || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/** Clamp `page` into the valid range [1, pageCount(total, size)]. A
 * non-finite or fractional page is truncated first. */
export function clampPage(page: number, total: number, size: number): number {
  const count = pageCount(total, size);
  const truncated = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.min(Math.max(1, truncated), count);
}

/** The half-open [start, end) row-index range `page` (1-based) covers. Page
 * is clamped first, so this never runs off the end of the row list. */
export function pageSlice(total: number, page: number, size: number): { start: number; end: number } {
  const clamped = clampPage(page, total, size);
  const start = total <= 0 ? 0 : (clamped - 1) * size;
  const end = Math.min(start + size, Math.max(total, 0));
  return { start, end: Math.max(start, end) };
}

/** The 1-based page that a 0-based row index falls on, at `size` rows per
 * page. Used to keep a visible row in view when the page size changes. */
export function pageForRow(rowIndex: number, size: number): number {
  if (!Number.isFinite(rowIndex) || rowIndex < 0 || !Number.isFinite(size) || size <= 0) return 1;
  return Math.floor(rowIndex / size) + 1;
}

/** Normalize a possibly missing/invalid stored page size (e.g. from
 * already-saved ViewState predating pagination) to one of PAGE_SIZES,
 * defaulting to DEFAULT_PAGE_SIZE. */
export function normalizePageSize(value: unknown): number {
  if (typeof value === "number" && (PAGE_SIZES as readonly number[]).includes(value)) return value;
  return DEFAULT_PAGE_SIZE;
}
