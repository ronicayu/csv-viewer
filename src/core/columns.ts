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

import { looksLikeJsonObjectOrArray } from "./json";
import { parseNumber } from "./number";
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

// ---- Column profiling (smart default column split) ------------------------
//
// See docs/reviews/pm-review.md §4 ("Default: first 8 columns in table").
// The worker samples the first ~200 data rows once per `init` and computes
// one ColumnProfile per column; reconcileVisibility below uses it (when
// provided) to decide, for columns with no stored per-file choice, whether
// they start in the table ("short") or in row details — instead of the
// old purely positional "first N columns" rule.

/** How many data rows the worker samples to build each column's profile.
 * Exported so the worker and this module's own tests agree on the number. */
export const PROFILE_SAMPLE_ROWS = 200;

/** A column is not "short" if its median trimmed length exceeds this many
 * characters. */
const SHORT_MEDIAN_LENGTH_MAX = 60;
/** A column is not "short" if at least this fraction of its non-empty
 * sampled values contain a line break. */
const SHORT_MULTILINE_SHARE_MAX = 0.1;
/** A column is not "short" if at least this fraction of its non-empty
 * sampled values parse as a JSON object/array. */
const SHORT_JSON_SHARE_MAX = 0.5;
/** A column is treated as numeric (for right-alignment) when at least
 * this fraction of its non-empty sampled values parse via parseNumber. */
export const NUMERIC_SHARE_THRESHOLD = 0.9;

export interface ColumnProfile {
  /** Median of `value.trim().length` over the sampled non-empty values. 0
   * when there are no non-empty sampled values. */
  medianLength: number;
  /** Fraction (0–1) of sampled non-empty values containing "\n". */
  multilineShare: number;
  /** Fraction (0–1) of sampled non-empty values that are a JSON object or
   * array (see src/core/json.ts). */
  jsonShare: number;
  /** Fraction (0–1) of sampled non-empty values that parse via
   * src/core/number.ts's parseNumber. */
  numericShare: number;
}

function median(sortedAscendingLengths: number[]): number {
  const n = sortedAscendingLengths.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAscendingLengths[mid - 1] + sortedAscendingLengths[mid]) / 2 : sortedAscendingLengths[mid];
}

/**
 * Profiles every column over the first `sampleSize` rows of `rows` (the
 * whole dataset is typically far larger — see docs/spec.md's "Performance"
 * section; sampling keeps this cheap even for a 500 MB file). Pure
 * function: `rows` is read, never mutated. A row shorter than `headers`
 * (a ragged CSV line) simply contributes nothing for the missing columns,
 * same as an empty value would.
 */
export function profileColumns(headers: string[], rows: string[][], sampleSize: number = PROFILE_SAMPLE_ROWS): ColumnProfile[] {
  const sample = rows.slice(0, sampleSize);
  return headers.map((_, columnIndex) => {
    const lengths: number[] = [];
    let nonEmpty = 0;
    let multiline = 0;
    let json = 0;
    let numeric = 0;
    for (const row of sample) {
      const value = row[columnIndex];
      if (value === undefined || value === "") continue;
      nonEmpty++;
      lengths.push(value.trim().length);
      if (value.includes("\n")) multiline++;
      if (looksLikeJsonObjectOrArray(value)) json++;
      if (parseNumber(value) !== null) numeric++;
    }
    lengths.sort((a, b) => a - b);
    return {
      medianLength: median(lengths),
      multilineShare: nonEmpty > 0 ? multiline / nonEmpty : 0,
      jsonShare: nonEmpty > 0 ? json / nonEmpty : 0,
      numericShare: nonEmpty > 0 ? numeric / nonEmpty : 0,
    };
  });
}

/** A column with no profile at all (e.g. a header beyond the profiled
 * array's length — shouldn't happen, but defensive) is treated as short,
 * same as an all-empty column (every "not short" criterion needs
 * non-empty sampled values to trip). */
function isShortColumn(profile: ColumnProfile | undefined): boolean {
  if (!profile) return true;
  if (profile.medianLength > SHORT_MEDIAN_LENGTH_MAX) return false;
  if (profile.multilineShare >= SHORT_MULTILINE_SHARE_MAX) return false;
  if (profile.jsonShare >= SHORT_JSON_SHARE_MAX) return false;
  return true;
}

/** Whether `column` should be right-aligned in the table body (see
 * src/webview/main.ts's per-cell `numeric-cell` class). */
export function isNumericColumn(profile: ColumnProfile | undefined): boolean {
  return (profile?.numericShare ?? 0) >= NUMERIC_SHARE_THRESHOLD;
}

/**
 * When the header row changes (columns added/removed/renamed), keep the
 * visibility setting for columns whose names still exist. For columns that
 * are new (no stored choice):
 *
 * - Without `profiles`: the old purely positional rule — the first
 *   `defaultTableColumns` columns (by index in `headers`) go in the table.
 * - With `profiles`: walk `headers` in file order and put a column in the
 *   table if it's "short" (see isShortColumn), until a budget of
 *   `defaultTableColumns` minus however many columns are ALREADY visible
 *   via a stored choice is used up — so the cap still bounds the total
 *   number of table columns, stored choices included. If that leaves zero
 *   columns visible on an otherwise completely fresh file (no stored
 *   choice for any current header) and the cap is at least 1, the first
 *   column is forced visible, so the table is never left with literally
 *   nothing in it the first time a file is opened. A file whose columns
 *   are all short behaves exactly like the old positional rule, since the
 *   first `defaultTableColumns` short columns in file order ARE the first
 *   `defaultTableColumns` columns.
 *
 * Either way this MERGES rather than replaces: every entry in `previous`
 * is carried into the result, including ones for header names not in the
 * current `headers` list — see the doc comment that used to live here
 * (and still applies) about surviving the "first row is header" round
 * trip. Only the current `headers` decide what's actually shown/hidden
 * right now (visibleColumns/detailFieldsFor only look at the current
 * header list); a stale retained entry for a column that's gone for good
 * is harmless dead weight, not a bug.
 */
export function reconcileVisibility(
  headers: string[],
  previous: ColumnVisibilityMap,
  defaultTableColumns: number,
  profiles?: ColumnProfile[],
): ColumnVisibilityMap {
  const map = createVisibilityMap();
  for (const key of Object.keys(previous)) {
    setVisibility(map, key, getVisibility(previous, key) as boolean);
  }

  if (!profiles) {
    headers.forEach((h, i) => {
      setVisibility(map, h, hasVisibility(previous, h) ? (getVisibility(previous, h) as boolean) : i < defaultTableColumns);
    });
    return map;
  }

  const anyStoredForCurrentHeaders = headers.some((h) => hasVisibility(previous, h));
  let visibleBudget = defaultTableColumns;
  let anyVisible = false;
  headers.forEach((h) => {
    if (hasVisibility(previous, h) && getVisibility(previous, h) === true) {
      visibleBudget--;
      anyVisible = true;
    }
  });

  headers.forEach((h, i) => {
    if (hasVisibility(previous, h)) return; // stored choice always wins — already copied above
    const visible = isShortColumn(profiles[i]) && visibleBudget > 0;
    setVisibility(map, h, visible);
    if (visible) {
      visibleBudget--;
      anyVisible = true;
    }
  });

  // Guarantee: a completely fresh file (no stored choice for any current
  // header) with a non-zero cap always starts with at least one column in
  // the table, even if none qualified as "short" — the first column, in
  // that case. A cap of 0 still means none (checked explicitly — don't
  // let this guarantee override it).
  if (!anyVisible && !anyStoredForCurrentHeaders && defaultTableColumns > 0 && headers.length > 0) {
    setVisibility(map, headers[0], true);
  }

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
