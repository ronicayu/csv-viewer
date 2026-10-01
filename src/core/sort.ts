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
export interface ResolvedCellSortKey extends CellSortKey {
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

/**
 * Computes the resolved sort key (kind/num/rank) for every row in `rows`,
 * for one column — exactly the per-column precompute `sortRows` always
 * did inline, extracted so a caller that wants to *cache* this across
 * multiple sorts (see worker.ts: the same column's keys are reused
 * unchanged across every subsequent query, as long as the underlying
 * rows haven't been re-parsed) can call it once and reuse the result,
 * instead of paying the collator-ranking pass again on every call.
 *
 * The rank is resolved from the distinct text values within *this* call's
 * `rows` — but since rank is just a monotonic relabeling of the
 * collator's order over the *set of distinct values considered*, and two
 * values that are collator-equal are always assigned equal ranks
 * regardless of what else was in that set, a caller may safely pass the
 * *entire* dataset once (rather than only ever the currently-filtered
 * subset) and reuse the resulting keys — by row id — for any filtered
 * subset's relative order via `sortRowIdsByCachedKeys`, with identical
 * results to calling this per-subset every time.
 */
/** Above this many distinct text values, ranking through a Set + Map of
 * strings costs more in hashing than sorting row indexes directly. */
const DISTINCT_TEXT_HASH_LIMIT = 20_000;

export function buildColumnSortKeys(rows: string[][], columnIndex: number): ResolvedCellSortKey[] {
  const cells = rows.map((row) => cellSortKey(row[columnIndex] ?? "")) as ResolvedCellSortKey[];

  // Few distinct values (status, country, ...): rank each distinct value
  // once and look it up per cell. Bail out as soon as the column turns out
  // to be mostly-unique text (names, ids, notes).
  const distinctText = new Set<string>();
  let fewDistinct = true;
  for (const k of cells) {
    if (k.kind !== "text") continue;
    distinctText.add(k.text);
    if (distinctText.size > DISTINCT_TEXT_HASH_LIMIT) {
      fewDistinct = false;
      break;
    }
  }

  if (fewDistinct) {
    const sortedText = Array.from(distinctText).sort((a, b) => collator.compare(a, b));
    // Values the collator considers equal (e.g. "a" and "A") share a rank,
    // so they tie and fall through to later keys / original row order.
    const rankOf = new Map<string, number>();
    let rank = 0;
    sortedText.forEach((text, i) => {
      if (i > 0 && collator.compare(sortedText[i - 1], text) !== 0) rank++;
      rankOf.set(text, rank);
    });
    for (const k of cells) k.rank = k.kind === "text" ? (rankOf.get(k.text) as number) : 0;
    return cells;
  }

  // Many distinct values: sort the text cells' indexes by the collator and
  // hand out ranks in one pass, with no per-string hashing. Collator-equal
  // neighbours share a rank, same as above.
  const textIndexes: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].kind === "text") textIndexes.push(i);
    else cells[i].rank = 0;
  }
  textIndexes.sort((x, y) => collator.compare(cells[x].text, cells[y].text));
  let rank = 0;
  for (let j = 0; j < textIndexes.length; j++) {
    if (j > 0 && collator.compare(cells[textIndexes[j - 1]].text, cells[textIndexes[j]].text) !== 0) rank++;
    cells[textIndexes[j]].rank = rank;
  }
  return cells;
}

/**
 * Sorts `ids` (a list of row identifiers — indices into whatever full
 * row set `sortColumns`' keys were built against, e.g. a filtered
 * subset's original ids) by one or more precomputed per-column key
 * arrays (see `buildColumnSortKeys`), stable, exactly like `sortRows`'s
 * own comparator. `ids` need not be a contiguous or full range — this is
 * what lets a filtered subset be sorted by reusing sort keys computed
 * once over the *entire* dataset, without re-deriving them.
 *
 * The stable tie-break (`x - y`, comparing the ids themselves) relies on
 * `ids` always being a subsequence that preserves the original row
 * order (true for anything produced by filtering rows in order, e.g.
 * `Array.prototype.filter`) — under that assumption, comparing id values
 * directly is equivalent to comparing their positions within `ids`.
 */
export function sortRowIdsByCachedKeys(
  ids: number[],
  sortColumns: { direction: SortDirection; keys: ResolvedCellSortKey[] }[],
): number[] {
  if (sortColumns.length === 0) return ids.slice();
  const order = ids.slice();
  order.sort((x, y) => {
    for (const { direction, keys } of sortColumns) {
      const cmp = compareResolvedCellSortKeys(keys[x], keys[y], direction);
      if (cmp !== 0) return cmp;
    }
    return x - y;
  });
  return order;
}

export function sortRows(rows: string[][], headers: string[], keys: SortKey[]): string[][] {
  if (keys.length === 0) return rows.slice();

  const columnIndex = new Map(headers.map((h, i) => [h, i]));
  const activeKeys = keys
    .map((key) => ({ direction: key.direction, columnIndex: columnIndex.get(key.column) }))
    .filter((k): k is { direction: SortDirection; columnIndex: number } => k.columnIndex !== undefined);
  if (activeKeys.length === 0) return rows.slice();

  // Precompute every active column's sort key for every row exactly once,
  // up front — the comparator below only ever reads these, never
  // re-parses a cell.
  const sortColumns = activeKeys.map(({ direction, columnIndex: ci }) => ({
    direction,
    keys: buildColumnSortKeys(rows, ci),
  }));

  const ids = rows.map((_, i) => i);
  const order = sortRowIdsByCachedKeys(ids, sortColumns);
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
