import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { cellSortKey, compareCellSortKeys, cycleSortForColumn, sortRows } from "../../core/sort";
import type { SortDirection, SortKey } from "../../core/types";
import { perfBoundMs } from "./perfEnv";

describe("comparator consistency (total order)", () => {
  it("places '10' and '1e1' (which tie numerically at 10) consistently relative to '1x' (non-numeric), instead of sorting '1x' between them", () => {
    const headers = ["v"];
    const rows = [["10"], ["1x"], ["1e1"]];
    const sorted = sortRows(rows, headers, [{ column: "v", direction: "asc" }]);
    const idx10 = sorted.findIndex((r) => r[0] === "10");
    const idx1e1 = sorted.findIndex((r) => r[0] === "1e1");
    const idx1x = sorted.findIndex((r) => r[0] === "1x");
    const bothSideOf1x = (idx10 < idx1x) === (idx1e1 < idx1x);
    expect(bothSideOf1x).toBe(true);
    expect(idx10).toBeLessThan(idx1x);
    expect(idx1e1).toBeLessThan(idx1x);
  });

  it("regression guard: a direct sign-consistency check on the actual fixed comparator (compareCellSortKeys), for the exact A/B/C triple that broke the old per-pair comparator ('10'~'1e1' tie, both vs. '1x')", () => {
    const direction: SortDirection = "asc";
    const a = cellSortKey("10");
    const b = cellSortKey("1e1");
    const c = cellSortKey("1x");
    expect(compareCellSortKeys(a, b, direction)).toBe(0);
    const ac = Math.sign(compareCellSortKeys(a, c, direction));
    const bc = Math.sign(compareCellSortKeys(b, c, direction));
    expect(ac).toBe(bc);
  });

  it("property: the fixed comparator (compareCellSortKeys, via cellSortKey) has zero transitivity violations across random mixes of numbers, numeric-looking strings, text, and empties — the same style of hunt that used to find violations before the fix", () => {
    const pool = ["10", "9", "1e1", "abc", "-5", "0x1", "1x", "15x", "0x10", "1,000", "20", "abc2", "ABC", "", "  "];
    function sign(x: number): number {
      return x === 0 ? 0 : x > 0 ? 1 : -1;
    }
    let violations = 0;
    for (const direction of ["asc", "desc"] as const) {
      const keys = new Map(pool.map((v) => [v, cellSortKey(v)]));
      for (const A of pool) {
        for (const B of pool) {
          for (const C of pool) {
            if (A === B || B === C || A === C) continue;
            const ab = sign(compareCellSortKeys(keys.get(A)!, keys.get(B)!, direction));
            const bc = sign(compareCellSortKeys(keys.get(B)!, keys.get(C)!, direction));
            const ac = sign(compareCellSortKeys(keys.get(A)!, keys.get(C)!, direction));
            const isTransitive = !((ab <= 0 && bc <= 0 && ac > 0) || (ab >= 0 && bc >= 0 && ac < 0));
            if (!isTransitive) violations++;
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`sort comparator transitivity violations found over ${pool.length}^3 triples x 2 directions:`, violations);
    expect(violations).toBe(0);
  });

  it("property (fast-check): random value sets never produce a transitivity violation", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.integer({ min: -1000, max: 1000 }).map(String),
            fc.constantFrom("abc", "1x", "0x10", "1,000", "Infinity", "5%", "$5", "", "  ", "1e3"),
          ),
          { minLength: 3, maxLength: 12 },
        ),
        fc.constantFrom<SortDirection>("asc", "desc"),
        (values, direction) => {
          const keys = values.map(cellSortKey);
          for (let i = 0; i < keys.length; i++) {
            for (let j = 0; j < keys.length; j++) {
              for (let k = 0; k < keys.length; k++) {
                const ab = Math.sign(compareCellSortKeys(keys[i], keys[j], direction));
                const bc = Math.sign(compareCellSortKeys(keys[j], keys[k], direction));
                const ac = Math.sign(compareCellSortKeys(keys[i], keys[k], direction));
                const violated = (ab <= 0 && bc <= 0 && ac > 0) || (ab >= 0 && bc >= 0 && ac < 0);
                expect(violated).toBe(false);
              }
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("ascending vs descending are exact reverses (except empties stay last both ways)", () => {
  it("property: reversing a fully-numeric or fully-text column and flipping direction gives the same result, and empties are always last", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer({ min: -1000, max: 1000 }).map(String), fc.constant("")), { minLength: 0, maxLength: 30 }),
        (values) => {
          const rows = values.map((v) => [v]);
          const asc = sortRows(rows, ["v"], [{ column: "v", direction: "asc" }]).map((r) => r[0]);
          const desc = sortRows(rows, ["v"], [{ column: "v", direction: "desc" }]).map((r) => r[0]);

          const nonEmptyAsc = asc.filter((v) => v.trim() !== "");
          const nonEmptyDesc = desc.filter((v) => v.trim() !== "");
          const emptyCount = values.filter((v) => v.trim() === "").length;

          expect(asc.slice(asc.length - emptyCount).every((v) => v.trim() === "")).toBe(true);
          expect(desc.slice(desc.length - emptyCount).every((v) => v.trim() === "")).toBe(true);

          expect(nonEmptyAsc).toEqual(nonEmptyDesc.slice().reverse());
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("stability with multi-key sorting", () => {
  it("ties on all keys preserve original row order", () => {
    const headers = ["a", "b"];
    const rows = [
      ["x", "1"],
      ["y", "1"],
      ["z", "1"],
    ];
    const sorted = sortRows(rows, headers, [{ column: "b", direction: "asc" }]);
    expect(sorted.map((r) => r[0])).toEqual(["x", "y", "z"]);
  });

  it("a sort key on a column that doesn't exist is silently skipped (columnIndex undefined -> continue), falling through to later keys or original order", () => {
    const headers = ["a", "b"];
    const rows = [
      ["2", "z"],
      ["1", "y"],
    ];
    const keys: SortKey[] = [{ column: "ghost", direction: "asc" }, { column: "a", direction: "asc" }];
    const sorted = sortRows(rows, headers, keys);
    expect(sorted.map((r) => r[0])).toEqual(["1", "2"]);
  });

  it("all keys on missing columns leaves rows in original order (every key skipped, falls to index tiebreak)", () => {
    const headers = ["a", "b"];
    const rows = [
      ["2", "z"],
      ["1", "y"],
    ];
    const sorted = sortRows(rows, headers, [{ column: "ghost1", direction: "asc" }, { column: "ghost2", direction: "desc" }]);
    expect(sorted).toEqual(rows);
  });
});

describe("cycleSortForColumn: random click / shift-click sequences never produce duplicate keys or invalid directions", () => {
  it("property: any sequence of (column, shift) clicks keeps keys.length columns unique and every direction 'asc'|'desc'", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            column: fc.constantFrom("a", "b", "c"),
            shift: fc.boolean(),
          }),
          { minLength: 0, maxLength: 50 },
        ),
        (clicks) => {
          let keys: SortKey[] = [];
          for (const click of clicks) {
            keys = cycleSortForColumn(keys, click.column, click.shift);
            const columns = keys.map((k) => k.column);
            expect(new Set(columns).size).toBe(columns.length);
            for (const k of keys) {
              expect(["asc", "desc"] as SortDirection[]).toContain(k.direction);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a plain (non-shift) click always collapses to at most one key", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "b", "c"), { minLength: 0, maxLength: 20 }), (cols) => {
        let keys: SortKey[] = [];
        for (const c of cols) {
          keys = cycleSortForColumn(keys, c, false);
          expect(keys.length).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("performance: 500k rows x 20 cols, multi-key sort", () => {
  it("sorts 500,000 rows on 3 keys in a reasonable time (prints actual timing; flags if over ~1s)", () => {
    const N = 500_000;
    const headers = Array.from({ length: 20 }, (_, i) => `col${i}`);
    const rows: string[][] = new Array(N);
    for (let i = 0; i < N; i++) {
      const row = new Array(20);
      for (let c = 0; c < 20; c++) {
        row[c] = c === 0 ? String(N - i) : c === 1 ? String(i % 997) : `text-${(i * 31 + c) % 5000}`;
      }
      rows[i] = row;
    }
    const keys: SortKey[] = [
      { column: "col1", direction: "asc" },
      { column: "col2", direction: "desc" },
      { column: "col0", direction: "asc" },
    ];
    const start = performance.now();
    const sorted = sortRows(rows, headers, keys);
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`sortRows: 500k rows x 20 cols, 3 sort keys: ${ms.toFixed(1)}ms${ms > 1200 ? "  <-- OVER the 1.2s perf target" : ""}`);
    expect(sorted.length).toBe(N);
    expect(ms).toBeLessThan(perfBoundMs(15_000, 60_000));
  }, 65000);
});
