import { parseNumber } from "./number";

export interface DistinctValue {
  value: string;
  count: number;
}

export interface DistinctResult {
  values: DistinctValue[];
  truncated: boolean;
}

export interface DistinctCaps {
  maxDistinct: number;
  maxChars: number;
}

export const DEFAULT_DISTINCT_CAPS: DistinctCaps = { maxDistinct: 10_000, maxChars: 2_000_000 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function distinctValues(rows: string[][], columnIndex: number, caps: Partial<DistinctCaps> = {}): DistinctResult {
  const maxDistinct = caps.maxDistinct ?? DEFAULT_DISTINCT_CAPS.maxDistinct;
  const maxChars = caps.maxChars ?? DEFAULT_DISTINCT_CAPS.maxChars;

  const counts = new Map<string, number>();
  let totalChars = 0;
  let full = false;
  for (const row of rows) {
    const value = row[columnIndex] ?? "";
    const existing = counts.get(value);
    if (existing !== undefined) {
      counts.set(value, existing + 1);
      continue;
    }
    if (full) continue;
    if (counts.size >= maxDistinct || totalChars + value.length > maxChars) {
      full = true;
      continue;
    }
    counts.set(value, 1);
    totalChars += value.length;
  }

  interface Entry extends DistinctValue {
    num: number | null;
  }
  const entries: Entry[] = [];
  for (const [value, count] of counts) entries.push({ value, count, num: value === "" ? null : parseNumber(value) });

  const group = (e: Entry): number => (e.value === "" ? 0 : e.num !== null ? 1 : 2);
  const compareRaw = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  entries.sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 1) {
      const cmp = a.num! - b.num!;
      if (cmp !== 0) return cmp;
    } else if (ga === 2) {
      const cmp = collator.compare(a.value, b.value);
      if (cmp !== 0) return cmp;
    }
    return compareRaw(a.value, b.value);
  });

  return { values: entries.map(({ value, count }) => ({ value, count })), truncated: full };
}
