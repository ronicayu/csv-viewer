// Row sorting: type-aware comparison (numeric when a value parses as a
// number per src/core/number.ts, else locale-aware string compare), empty
// cells always last, stable across multiple sort keys. Pure module, no
// vscode/DOM.
//
// The comparator computes ONE canonical sort key per cell, per sort column,
// up front — rather than re-deriving "is this numeric?" for each pairwise
// comparison during the sort. Re-deriving per pair is what the previous
// version of this module did, and it made the comparator a non-transitive
// relation for value sets like {"10", "1e1", "1x"}: "10" and "1e1" tie
// numerically, but "1e1" vs "1x" and "10" vs "1x" each independently fell
// back to string collation, which doesn't agree with the numeric tie or
// with each other — corrupting Array.prototype.sort, whose contract
// requires a consistent total order. Precomputing each cell's kind
// (empty/numeric/text) once, before any comparisons happen, makes the
// resulting order a genuine total order: empty < non-empty always; among
// non-empty, numeric and text are separated by a direction-dependent (but
// per-key-consistent) rule, and within a kind, numeric compares by value
// and text by a single shared collator.

import { parseNumber } from "./number";
import type { SortDirection, SortKey } from "./types";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export type CellSortKind = "empty" | "numeric" | "text";

export interface CellSortKey {
  kind: CellSortKind;
  num: number;
  text: string;
}

/** Compute the one canonical sort key for a cell value. */
export function cellSortKey(value: string): CellSortKey {
  if (value.trim() === "") return { kind: "empty", num: 0, text: "" };
  const num = parseNumber(value);
  if (num !== null) return { kind: "numeric", num, text: "" };
  return { kind: "text", num: 0, text: value };
}

/**
 * Compare two precomputed sort keys for one sort column. Empty always
 * sorts last, in both directions. Among non-empty keys, numeric sorts
 * before text in ascending order and after text in descending order
 * (direction flips that relative ordering, same as it flips numeric-vs-
 * numeric and text-vs-text); within the same kind, numeric compares by
 * value and text via the shared collator, both direction-adjusted.
 */
export function compareCellSortKeys(a: CellSortKey, b: CellSortKey, direction: SortDirection): number {
  if (a.kind === "empty" && b.kind === "empty") return 0;
  if (a.kind === "empty") return 1;
  if (b.kind === "empty") return -1;

  if (a.kind === "numeric" && b.kind === "numeric") {
    const cmp = a.num - b.num;
    return direction === "desc" ? -cmp : cmp;
  }
  if (a.kind === "text" && b.kind === "text") {
    const cmp = collator.compare(a.text, b.text);
    return direction === "desc" ? -cmp : cmp;
  }
  // One numeric, one text.
  const cmp = a.kind === "numeric" ? -1 : 1;
  return direction === "desc" ? -cmp : cmp;
}

/** A cell sort key with its text rank resolved: for `kind === "text"`, its
 * index in this column's values sorted once by the collator, so the main
 * sort's comparator does a cheap number subtraction instead of calling
 * `Intl.Collator.compare` again for every pairwise comparison — which
 * matters at scale, since a column with many repeated/tied values (e.g. a
 * secondary sort key) can otherwise call the collator millions of times. */
interface ResolvedCellSortKey extends CellSortKey {
  rank: number;
}

function compareResolvedCellSortKeys(a: ResolvedCellSortKey, b: ResolvedCellSortKey, direction: SortDirection): number {
  if (a.kind === "empty" && b.kind === "empty") return 0;
  if (a.kind === "empty") return 1;
  if (b.kind === "empty") return -1;

  if (a.kind === "numeric" && b.kind === "numeric") {
    const cmp = a.num - b.num;
    return direction === "desc" ? -cmp : cmp;
  }
  if (a.kind === "text" && b.kind === "text") {
    const cmp = a.rank - b.rank;
    return direction === "desc" ? -cmp : cmp;
  }
  const cmp = a.kind === "numeric" ? -1 : 1;
  return direction === "desc" ? -cmp : cmp;
}

export function sortRows(rows: string[][], headers: string[], keys: SortKey[]): string[][] {
  if (keys.length === 0) return rows.slice();

  const columnIndex = new Map(headers.map((h, i) => [h, i]));
  const activeKeys = keys
    .map((key) => ({ direction: key.direction, columnIndex: columnIndex.get(key.column) }))
    .filter((k): k is { direction: SortDirection; columnIndex: number } => k.columnIndex !== undefined);

  // Precompute every active column's sort key for every row exactly once,
  // up front — the comparator below only ever reads these, never
  // re-parses a cell. Also resolve each text value's collation rank once
  // per distinct value in that column (see ResolvedCellSortKey) rather
  // than re-running the collator on every comparison during the sort.
  const keyMatrices = activeKeys.map(({ direction, columnIndex: ci }) => {
    const cells = rows.map((row) => cellSortKey(row[ci] ?? "")) as ResolvedCellSortKey[];
    const distinctText = new Set<string>();
    for (const k of cells) if (k.kind === "text") distinctText.add(k.text);
    const sortedText = Array.from(distinctText).sort((a, b) => collator.compare(a, b));
    const rankOf = new Map(sortedText.map((text, i) => [text, i]));
    // Mutate in place (these cell-key objects were just freshly allocated
    // above and aren't shared with anything else) rather than spreading
    // into a second array of objects — halves the allocation for large
    // datasets.
    for (const k of cells) k.rank = k.kind === "text" ? (rankOf.get(k.text) as number) : 0;
    return { direction, cells };
  });

  const order = rows.map((_, i) => i);
  order.sort((x, y) => {
    for (const { direction, cells } of keyMatrices) {
      const cmp = compareResolvedCellSortKeys(cells[x], cells[y], direction);
      if (cmp !== 0) return cmp;
    }
    return x - y;
  });

  return order.map((i) => rows[i]);
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
