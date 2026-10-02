// Distinct values of one column, with row counts — the data behind the
// header funnel's "filter by values" picker. Pure module, no vscode/DOM;
// runs in the worker over every parsed row (not the filtered view).

import { parseNumber } from "./number";

export interface DistinctValue {
  value: string;
  count: number;
}

export interface DistinctResult {
  values: DistinctValue[];
  /** True when a cap was hit and some distinct values are not in `values`. */
  truncated: boolean;
}

export interface DistinctCaps {
  /** Most distinct values collected. */
  maxDistinct: number;
  /** Most total characters across the collected values (a column of huge
   * unique cells must not balloon the picker's payload). */
  maxChars: number;
}

export const DEFAULT_DISTINCT_CAPS: DistinctCaps = { maxDistinct: 10_000, maxChars: 2_000_000 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Distinct values of column `columnIndex` over ALL of `rows` (a missing
 * cell in a ragged row counts as `""`), with how many rows hold each.
 *
 * Once a cap is hit, no further NEW distinct value is added (`truncated`
 * becomes true) but rows holding an already-collected value keep being
 * counted, so every reported count is exact — only the list is incomplete.
 *
 * Order is deterministic: `""` first, then numeric values (shared
 * `parseNumber`) ascending by number, then text via a numeric-aware,
 * case-insensitive collator (same as sorting). Ties — `"10"` vs `"1e1"`, or
 * `"a"` vs `"A"` — fall back to raw-string comparison.
 *
 * Keyed by a `Map`, so values like `__proto__` or `constructor` are ordinary.
 */
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

  // 0 = blank, 1 = numeric, 2 = text.
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
