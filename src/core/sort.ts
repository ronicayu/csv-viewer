// Row sorting: type-aware comparison (numeric when both sides parse as
// finite numbers, else locale-aware string compare), empty cells always
// last, stable across multiple sort keys. Pure module, no vscode/DOM.

import type { SortDirection, SortKey } from "./types";

function parseNumeric(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compare two cell values for one sort key. Empty cells sort last
 * regardless of direction, so that check happens before the direction
 * multiplier is applied.
 */
function compareCells(a: string, b: string, direction: SortDirection): number {
  const aEmpty = a.trim() === "";
  const bEmpty = b.trim() === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const aNum = parseNumeric(a);
  const bNum = parseNumeric(b);
  const cmp =
    aNum !== null && bNum !== null ? aNum - bNum : a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

  return direction === "desc" ? -cmp : cmp;
}

export function sortRows(rows: string[][], headers: string[], keys: SortKey[]): string[][] {
  if (keys.length === 0) return rows.slice();

  const columnIndex = new Map(headers.map((h, i) => [h, i]));
  const indexed = rows.map((row, i) => ({ row, i }));

  indexed.sort((x, y) => {
    for (const key of keys) {
      const ci = columnIndex.get(key.column);
      if (ci === undefined) continue;
      const cmp = compareCells(x.row[ci] ?? "", y.row[ci] ?? "", key.direction);
      if (cmp !== 0) return cmp;
    }
    return x.i - y.i;
  });

  return indexed.map((e) => e.row);
}

/** Cycles a column's sort direction: none -> asc -> desc -> none. */
export function cycleSortForColumn(keys: SortKey[], column: string, multi: boolean): SortKey[] {
  const existingIndex = keys.findIndex((k) => k.column === column);

  if (!multi) {
    if (existingIndex === -1) return [{ column, direction: "asc" }];
    const existing = keys[existingIndex];
    if (existing.direction === "asc") return [{ column, direction: "desc" }];
    return [];
  }

  // Shift+click: add/advance this column as a secondary key, others untouched.
  if (existingIndex === -1) return [...keys, { column, direction: "asc" }];
  const existing = keys[existingIndex];
  const next = keys.slice();
  if (existing.direction === "asc") {
    next[existingIndex] = { column, direction: "desc" };
    return next;
  }
  next.splice(existingIndex, 1);
  return next;
}
