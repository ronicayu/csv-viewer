// Performance smoke tests: applyFilters over a large dataset with a mix of
// rule types including regex. Prints actual timings for the final report;
// only hard-fails on truly pathological (10x+) regressions so it stays a
// useful CI signal without being flaky across machines.
import { describe, expect, it } from "vitest";
import { applyFilters } from "../../core/filter";
import type { FilterRule } from "../../core/types";

function makeDataset(n: number, cols: number) {
  const headers = Array.from({ length: cols }, (_, i) => `col${i}`);
  const rows: string[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) {
      row[c] = c === 0 ? String(i) : c === 1 ? (i % 7 === 0 ? "" : `value-${i % 1000}`) : `col${c}-${(i * 13 + c) % 500}`;
    }
    rows[i] = row;
  }
  return { headers, rows };
}

describe("performance: applyFilters over 500k rows x 20 cols, 5 rules incl. regex", () => {
  it("completes and reports timing", () => {
    const { headers, rows } = makeDataset(500_000, 20);
    const rules: FilterRule[] = [
      { id: "1", column: "col1", operator: "contains", value: "value", mode: "include", caseSensitive: false, enabled: true },
      { id: "2", column: "col2", operator: "gt", value: "100", mode: "include", caseSensitive: false, enabled: true },
      { id: "3", column: null, operator: "regex", value: "^col\\d+-\\d{1,3}$", mode: "include", caseSensitive: false, enabled: true },
      { id: "4", column: "col1", operator: "isEmpty", value: "", mode: "exclude", caseSensitive: false, enabled: true },
      { id: "5", column: "col3", operator: "endsWith", value: "9", mode: "include", caseSensitive: false, enabled: true },
    ];

    const start = performance.now();
    const result = applyFilters(headers, rows, "", rules);
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`applyFilters: 500k rows x 20 cols, 5 rules (incl. regex): ${ms.toFixed(1)}ms${ms > 1000 ? "  <-- OVER 1s, UI-freeze risk" : ""}`);

    expect(Array.isArray(result)).toBe(true);
    // Generous ceiling: catches a real algorithmic regression (e.g.
    // accidental O(n^2)) without being flaky on a slow CI box.
    expect(ms).toBeLessThan(15_000);
  }, 30000);

  it("quick search alone over 500k rows x 20 cols", () => {
    const { headers, rows } = makeDataset(500_000, 20);
    const start = performance.now();
    const result = applyFilters(headers, rows, "value-42", []);
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`applyFilters: 500k rows x 20 cols, quick search only: ${ms.toFixed(1)}ms${ms > 1000 ? "  <-- OVER 1s, UI-freeze risk" : ""}`);
    expect(result.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(15_000);
  }, 30000);
});
