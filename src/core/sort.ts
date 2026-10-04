// Precompute one key per cell: per-pair numeric-vs-text checks are not transitive ("10", "1e1", "1x").

import { parseNumber } from "./number";
import type { SortDirection, SortKey } from "./types";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export type CellSortKind = "empty" | "numeric" | "text";

export interface CellSortKey {
  kind: CellSortKind;
  num: number;
  text: string;
}

export function cellSortKey(value: string): CellSortKey {
  if (value.trim() === "") return { kind: "empty", num: 0, text: "" };
  const num = parseNumber(value);
  if (num !== null) return { kind: "numeric", num, text: "" };
  return { kind: "text", num: 0, text: value };
}

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
  const cmp = a.kind === "numeric" ? -1 : 1;
  return direction === "desc" ? -cmp : cmp;
}

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

// Ranks depend only on collator order, so keys built over all rows stay valid for any filtered subset.
const DISTINCT_TEXT_HASH_LIMIT = 20_000;

export function buildColumnSortKeys(rows: string[][], columnIndex: number): ResolvedCellSortKey[] {
  const cells = rows.map((row) => cellSortKey(row[columnIndex] ?? "")) as ResolvedCellSortKey[];

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
    // Collator-equal values (e.g. "a" and "A") share a rank so they tie and fall through to later keys.
    const rankOf = new Map<string, number>();
    let rank = 0;
    sortedText.forEach((text, i) => {
      if (i > 0 && collator.compare(sortedText[i - 1], text) !== 0) rank++;
      rankOf.set(text, rank);
    });
    for (const k of cells) k.rank = k.kind === "text" ? (rankOf.get(k.text) as number) : 0;
    return cells;
  }

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

// The id tie-break is only stable if ids keep the original row order, as filtering does.
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

  const sortColumns = activeKeys.map(({ direction, columnIndex: ci }) => ({
    direction,
    keys: buildColumnSortKeys(rows, ci),
  }));

  const ids = rows.map((_, i) => i);
  const order = sortRowIdsByCachedKeys(ids, sortColumns);
  return order.map((i) => rows[i]);
}

export function cycleSortForColumn(keys: SortKey[], column: string, multi: boolean): SortKey[] {
  const existingIndex = keys.findIndex((k) => k.column === column);

  if (!multi) {
    if (existingIndex === -1) return [{ column, direction: "asc" }];
    const existing = keys[existingIndex];
    if (existing.direction === "asc") return [{ column, direction: "desc" }];
    return [];
  }

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
