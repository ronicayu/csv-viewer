export const PAGE_SIZES = [25, 50, 100, 200, 500] as const;
export const DEFAULT_PAGE_SIZE = 100;

export function pageCount(total: number, size: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(size) || size <= 0 || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

export function clampPage(page: number, total: number, size: number): number {
  const count = pageCount(total, size);
  const truncated = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.min(Math.max(1, truncated), count);
}

export function pageSlice(total: number, page: number, size: number): { start: number; end: number } {
  const clamped = clampPage(page, total, size);
  const start = total <= 0 ? 0 : (clamped - 1) * size;
  const end = Math.min(start + size, Math.max(total, 0));
  return { start, end: Math.max(start, end) };
}

export function pageForRow(rowIndex: number, size: number): number {
  if (!Number.isFinite(rowIndex) || rowIndex < 0 || !Number.isFinite(size) || size <= 0) return 1;
  return Math.floor(rowIndex / size) + 1;
}

export function normalizePageSize(value: unknown): number {
  if (typeof value === "number" && (PAGE_SIZES as readonly number[]).includes(value)) return value;
  return DEFAULT_PAGE_SIZE;
}
