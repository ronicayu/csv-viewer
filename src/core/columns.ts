import { looksLikeJsonObjectOrArray } from "./json";
import { looksLikeMarkdown } from "./markdownDetect";
import { parseNumber } from "./number";
import type { ColumnFlagMap, ColumnVisibilityMap } from "./types";

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

function isShortColumn(profile: ColumnProfile | undefined): boolean {
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

// Stored entries for headers absent from this parse are kept, so they return if the headers do.
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
    if (hasVisibility(previous, h)) return;
    const visible = isShortColumn(profiles[i]) && visibleBudget > 0;
    setVisibility(map, h, visible);
    if (visible) {
      visibleBudget--;
      anyVisible = true;
    }
  });

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

export function detailFieldsFor(headers: string[], visibility: ColumnVisibilityMap): string[] {
  const detailOnly = detailOnlyColumns(headers, visibility);
  return detailOnly.length > 0 ? detailOnly : headers;
}
