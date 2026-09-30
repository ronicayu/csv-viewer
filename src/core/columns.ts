// Column visibility: which columns show in the table vs. detail-only, the
// default rule for a freshly opened file, and reconciliation when the header
// row changes on reload. Pure module, no vscode/DOM.

import type { ColumnVisibilityMap } from "./types";

export function defaultVisibility(headers: string[], defaultTableColumns: number): ColumnVisibilityMap {
  const map: ColumnVisibilityMap = {};
  headers.forEach((h, i) => {
    map[h] = i < defaultTableColumns;
  });
  return map;
}

/**
 * When the header row changes (columns added/removed/renamed), keep the
 * visibility setting for columns whose names still exist; columns that are
 * new follow the default rule (first N in the table).
 */
export function reconcileVisibility(
  headers: string[],
  previous: ColumnVisibilityMap,
  defaultTableColumns: number,
): ColumnVisibilityMap {
  const map: ColumnVisibilityMap = {};
  headers.forEach((h, i) => {
    map[h] = Object.prototype.hasOwnProperty.call(previous, h) ? previous[h] : i < defaultTableColumns;
  });
  return map;
}

export function visibleColumns(headers: string[], visibility: ColumnVisibilityMap): string[] {
  return headers.filter((h) => visibility[h] !== false);
}

export function detailOnlyColumns(headers: string[], visibility: ColumnVisibilityMap): string[] {
  return headers.filter((h) => visibility[h] === false);
}

/** Columns shown in a row's detail panel: detail-only columns, or every
 * column when nothing is hidden. */
export function detailFieldsFor(headers: string[], visibility: ColumnVisibilityMap): string[] {
  const detailOnly = detailOnlyColumns(headers, visibility);
  return detailOnly.length > 0 ? detailOnly : headers;
}
