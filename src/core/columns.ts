import { looksLikeJsonObjectOrArray } from "./json";
import { looksLikeMarkdown } from "./markdownDetect";
import { parseNumber } from "./number";
import type { ColumnFlagMap, ColumnVisibilityMap } from "./types";

// Past this many columns the UI lists only the first ones and stops pinning a visibility key per header; see reconcileVisibility.
export const MANY_COLUMNS = 1000;

export function createVisibilityMap(): ColumnVisibilityMap {
  return {};
}

// Use own-property accessors: a header named "__proto__" breaks plain map[h] reads and writes.
export function hasColumnFlag(map: ColumnFlagMap, header: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, header);
}

export function getColumnFlag(map: ColumnFlagMap, header: string): boolean | undefined {
  return hasColumnFlag(map, header) ? (map[header] as boolean) : undefined;
}

export function setColumnFlag(map: ColumnFlagMap, header: string, value: boolean): void {
  Object.defineProperty(map, header, { value, enumerable: true, writable: true, configurable: true });
}

export function normalizeColumnFlags(raw: unknown): ColumnFlagMap {
  const map: ColumnFlagMap = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return map;
  for (const key of Object.keys(raw)) {
    const value = Object.getOwnPropertyDescriptor(raw, key)?.value;
    if (typeof value === "boolean") setColumnFlag(map, key, value);
  }
  return map;
}

export const hasVisibility = hasColumnFlag;
export const getVisibility = getColumnFlag;
export const setVisibility = setColumnFlag;

export function defaultVisibility(headers: string[], defaultTableColumns: number): ColumnVisibilityMap {
  const map = createVisibilityMap();
  headers.forEach((h, i) => {
    setVisibility(map, h, i < defaultTableColumns);
  });
  return map;
}

export const PROFILE_SAMPLE_ROWS = 200;

const SHORT_MEDIAN_LENGTH_MAX = 60;
const SHORT_MULTILINE_SHARE_MAX = 0.1;
const SHORT_JSON_SHARE_MAX = 0.5;
export const NUMERIC_SHARE_THRESHOLD = 0.9;
export const MARKDOWN_SHARE_THRESHOLD = 0.1;

export interface ColumnProfile {
  medianLength: number;
  multilineShare: number;
  jsonShare: number;
  numericShare: number;
  markdownShare: number;
}

function median(sortedAscendingLengths: number[]): number {
  const n = sortedAscendingLengths.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAscendingLengths[mid - 1] + sortedAscendingLengths[mid]) / 2 : sortedAscendingLengths[mid];
}

export function profileColumns(headers: string[], rows: string[][], sampleSize: number = PROFILE_SAMPLE_ROWS): ColumnProfile[] {
  const sample = rows.slice(0, sampleSize);
  return headers.map((_, columnIndex) => {
    const lengths: number[] = [];
    let nonEmpty = 0;
    let multiline = 0;
    let json = 0;
    let numeric = 0;
    let markdown = 0;
    for (const row of sample) {
      const value = row[columnIndex];
      if (value === undefined || value === "") continue;
      nonEmpty++;
      lengths.push(value.trim().length);
      if (value.includes("\n")) multiline++;
      if (looksLikeJsonObjectOrArray(value)) json++;
      if (parseNumber(value) !== null) numeric++;
      if (looksLikeMarkdown(value)) markdown++;
    }
    lengths.sort((a, b) => a - b);
    return {
      medianLength: median(lengths),
      multilineShare: nonEmpty > 0 ? multiline / nonEmpty : 0,
      jsonShare: nonEmpty > 0 ? json / nonEmpty : 0,
      numericShare: nonEmpty > 0 ? numeric / nonEmpty : 0,
      markdownShare: nonEmpty > 0 ? markdown / nonEmpty : 0,
    };
  });
}

export function isShortColumn(profile: ColumnProfile | undefined): boolean {
  if (!profile) return true;
  if (profile.medianLength > SHORT_MEDIAN_LENGTH_MAX) return false;
  if (profile.multilineShare >= SHORT_MULTILINE_SHARE_MAX) return false;
  if (profile.jsonShare >= SHORT_JSON_SHARE_MAX) return false;
  return true;
}

export function isNumericColumn(profile: ColumnProfile | undefined): boolean {
  return (profile?.numericShare ?? 0) >= NUMERIC_SHARE_THRESHOLD;
}

export function isAutoMarkdownColumn(profile: ColumnProfile | undefined): boolean {
  return (profile?.markdownShare ?? 0) >= MARKDOWN_SHARE_THRESHOLD;
}

// What the profiles say about each column, one byte apiece: structured-cloning two million profile objects out of the worker takes seconds.
export const PROFILE_SHORT = 1;
export const PROFILE_NUMERIC = 2;
export const PROFILE_MARKDOWN = 4;

export function profileVerdicts(profiles: ColumnProfile[]): Uint8Array {
  const verdicts = new Uint8Array(profiles.length);
  profiles.forEach((profile, i) => {
    verdicts[i] = (isShortColumn(profile) ? PROFILE_SHORT : 0) | (isNumericColumn(profile) ? PROFILE_NUMERIC : 0) | (isAutoMarkdownColumn(profile) ? PROFILE_MARKDOWN : 0);
  });
  return verdicts;
}

// Whether each column is in the table by default (1) or only in the row details (0). A stored entry for the header decides that header
// and counts against the budget; the rest are taken in file order while the budget lasts. The profiles may come as the column's `short` verdict instead.
export function defaultVisibleFlags(
  headers: string[],
  previous: ColumnVisibilityMap,
  defaultTableColumns: number,
  profiles?: ColumnProfile[] | ((index: number) => boolean),
): Uint8Array {
  const flags = new Uint8Array(headers.length);
  const anyStored = Object.keys(previous).length > 0;
  const stored = (h: string): boolean | undefined => (anyStored ? getVisibility(previous, h) : undefined);
  const isShort = typeof profiles === "function" ? profiles : (i: number) => isShortColumn(profiles?.[i]);

  if (!profiles) {
    headers.forEach((h, i) => {
      const value = stored(h);
      flags[i] = (value !== undefined ? value : i < defaultTableColumns) ? 1 : 0;
    });
    return flags;
  }

  let anyStoredForCurrentHeaders = false;
  let visibleBudget = defaultTableColumns;
  let anyVisible = false;
  headers.forEach((h, i) => {
    const value = stored(h);
    if (value === undefined) return;
    anyStoredForCurrentHeaders = true;
    flags[i] = value ? 1 : 0;
    if (value) {
      visibleBudget--;
      anyVisible = true;
    }
  });

  headers.forEach((h, i) => {
    if (stored(h) !== undefined) return;
    const visible = isShort(i) && visibleBudget > 0;
    flags[i] = visible ? 1 : 0;
    if (visible) {
      visibleBudget--;
      anyVisible = true;
    }
  });

  if (!anyVisible && !anyStoredForCurrentHeaders && defaultTableColumns > 0 && headers.length > 0) flags[0] = 1;
  return flags;
}

function sameFlags(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// A state saved by 0.8.0 pins a key per header. Drops the keys that say what the defaults already say, provided every column keeps the
// visibility it had (stored entries count against the budget, so removing some can move it); tries all of them, then only the hidden ones.
function dropDefaultedKeys(
  headers: string[],
  stored: ColumnVisibilityMap,
  defaultTableColumns: number,
  profiles?: ColumnProfile[] | ((index: number) => boolean),
): ColumnVisibilityMap {
  if (Object.keys(stored).length === 0) return stored;
  const effective = defaultVisibleFlags(headers, stored, defaultTableColumns, profiles);
  const defaults = defaultVisibleFlags(headers, {}, defaultTableColumns, profiles);
  for (const onlyHidden of [false, true]) {
    const drop = new Set<string>();
    headers.forEach((h, i) => {
      const value = getVisibility(stored, h);
      if (value !== undefined && (value ? 1 : 0) === defaults[i] && (!onlyHidden || !value)) drop.add(h);
    });
    const compact = createVisibilityMap();
    for (const key of Object.keys(stored)) if (!drop.has(key)) setVisibility(compact, key, getVisibility(stored, key) as boolean);
    if (sameFlags(defaultVisibleFlags(headers, compact, defaultTableColumns, profiles), effective)) return compact;
  }
  return stored;
}

// Stored entries for headers absent from this parse are kept, so they return if the headers do.
// With more than MANY_COLUMNS headers no key is added per header: the map holds only what the user toggled, and the defaults come from
// defaultVisibleFlags on every load, so they are not pinned across reloads (a documented limit). Keys an older version pinned that equal
// those defaults are dropped.
export function reconcileVisibility(
  headers: string[],
  previous: ColumnVisibilityMap,
  defaultTableColumns: number,
  profiles?: ColumnProfile[] | ((index: number) => boolean),
): ColumnVisibilityMap {
  const map = createVisibilityMap();
  for (const key of Object.keys(previous)) {
    setVisibility(map, key, getVisibility(previous, key) as boolean);
  }
  if (headers.length > MANY_COLUMNS) return dropDefaultedKeys(headers, map, defaultTableColumns, profiles);

  const flags = defaultVisibleFlags(headers, previous, defaultTableColumns, profiles);
  headers.forEach((h, i) => {
    if (!hasVisibility(previous, h)) setVisibility(map, h, flags[i] === 1);
  });
  return map;
}

// A stored entry decides; otherwise the default flag for the column (in the table when there are none).
export function isColumnInTable(header: string, index: number, visibility: ColumnVisibilityMap, defaults?: Uint8Array | null): boolean {
  const stored = getVisibility(visibility, header);
  if (stored !== undefined) return stored;
  return defaults ? defaults[index] === 1 : true;
}

// With nothing stored (the usual case with very many columns) the defaults alone decide, without a property lookup per header.
function inTable(visibility: ColumnVisibilityMap, defaults?: Uint8Array | null): (header: string, index: number) => boolean {
  if (Object.keys(visibility).length > 0) return (h, i) => isColumnInTable(h, i, visibility, defaults);
  return defaults ? (_h, i) => defaults[i] === 1 : () => true;
}

export function visibleColumns(headers: string[], visibility: ColumnVisibilityMap, defaults?: Uint8Array | null): string[] {
  return headers.filter(inTable(visibility, defaults));
}

export function detailOnlyColumns(headers: string[], visibility: ColumnVisibilityMap, defaults?: Uint8Array | null): string[] {
  const included = inTable(visibility, defaults);
  return headers.filter((h, i) => !included(h, i));
}

export function detailFieldsFor(headers: string[], visibility: ColumnVisibilityMap, defaults?: Uint8Array | null): string[] {
  const detailOnly = detailOnlyColumns(headers, visibility, defaults);
  return detailOnly.length > 0 ? detailOnly : headers;
}
