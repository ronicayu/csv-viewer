// Column visibility: which columns show in the table vs. detail-only, the
// default rule for a freshly opened file, and reconciliation when the header
// row changes on reload. Pure module, no vscode/DOM.
//
// ColumnVisibilityMap is a plain object keyed by header name. A header
// literally named "__proto__" is dangerous with naive `map[h] = value`
// writes: `__proto__` is an ACCESSOR on Object.prototype whose setter
// silently no-ops for a non-object value, so the write never creates a real
// own property, and a later `map[h]` read falls through to the inherited
// accessor's getter (Object.prototype itself — an object, hence truthy and
// never `=== false`). Every write below goes through `setVisibility`
// (Object.defineProperty, which bypasses the accessor and always creates a
// real own data property, even for "__proto__") and every read goes through
// `getVisibility`/`hasVisibility` (Object.prototype.hasOwnProperty.call, so
// a read never falls through to an inherited value). This also keeps
// already-stored plain-object maps working: JSON.parse (from workspaceState)
// creates a genuine own "__proto__" property per the JSON spec — it's only
// a *runtime* `obj["__proto__"] = x` bracket-assignment on an ordinary
// object that's the no-op trap.

import type { ColumnVisibilityMap } from "./types";

export function createVisibilityMap(): ColumnVisibilityMap {
  return {};
}

export function hasVisibility(map: ColumnVisibilityMap, header: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, header);
}

export function getVisibility(map: ColumnVisibilityMap, header: string): boolean | undefined {
  return hasVisibility(map, header) ? (map[header] as boolean) : undefined;
}

export function setVisibility(map: ColumnVisibilityMap, header: string, value: boolean): void {
  Object.defineProperty(map, header, { value, enumerable: true, writable: true, configurable: true });
}

export function defaultVisibility(headers: string[], defaultTableColumns: number): ColumnVisibilityMap {
  const map = createVisibilityMap();
  headers.forEach((h, i) => {
    setVisibility(map, h, i < defaultTableColumns);
  });
  return map;
}

/**
 * When the header row changes (columns added/removed/renamed), keep the
 * visibility setting for columns whose names still exist; columns that are
 * new follow the default rule (first N in the table).
 *
 * This MERGES rather than replaces: every entry in `previous` is carried
 * into the result, including ones for header names not in the current
 * `headers` list. That's what lets a setting survive an intermediate
 * reconciliation against a *different* header set — e.g. toggling "first
 * row is header" off (synthesizing column_1..N headers) and back on (real
 * headers again) — since the original names' visibility is retained
 * through the round trip instead of being dropped the moment they're not
 * the current header set. Only the current `headers` below decide what's
 * actually shown/hidden right now (visibleColumns/detailFieldsFor only ever
 * look at the current header list), so a stale retained entry for a column
 * that's genuinely gone for good is harmless dead weight, not a bug.
 */
export function reconcileVisibility(
  headers: string[],
  previous: ColumnVisibilityMap,
  defaultTableColumns: number,
): ColumnVisibilityMap {
  const map = createVisibilityMap();
  for (const key of Object.keys(previous)) {
    setVisibility(map, key, getVisibility(previous, key) as boolean);
  }
  headers.forEach((h, i) => {
    setVisibility(map, h, hasVisibility(previous, h) ? (getVisibility(previous, h) as boolean) : i < defaultTableColumns);
  });
  return map;
}

export function visibleColumns(headers: string[], visibility: ColumnVisibilityMap): string[] {
  return headers.filter((h) => getVisibility(visibility, h) !== false);
}

export function detailOnlyColumns(headers: string[], visibility: ColumnVisibilityMap): string[] {
  return headers.filter((h) => getVisibility(visibility, h) === false);
}

/** Columns shown in a row's detail panel: detail-only columns, or every
 * column when nothing is hidden. */
export function detailFieldsFor(headers: string[], visibility: ColumnVisibilityMap): string[] {
  const detailOnly = detailOnlyColumns(headers, visibility);
  return detailOnly.length > 0 ? detailOnly : headers;
}
