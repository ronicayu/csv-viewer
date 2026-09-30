// Adversarial tests for src/core/sort.ts. The headline finding: compareCells
// picks numeric-vs-string comparison mode PER PAIR (based on whether each
// side individually parses as a finite number), rather than deriving one
// consistent sort key per value up front. That makes the comparator a
// non-transitive relation for certain value sets, which corrupts
// Array.prototype.sort (whose contract requires a consistent total order).
import { describe, expect, it, test } from "vitest";
import fc from "fast-check";
import { cycleSortForColumn, sortRows } from "../../core/sort";
import type { SortDirection, SortKey } from "../../core/types";

describe("comparator consistency (total order)", () => {
  test.fails(
    "BUG: the per-key comparator is not transitive, so Array.sort's contract is violated. Minimal repro: values '10' (numeric 10), '1e1' (numeric 10, textually different), and '1x' (non-numeric). '10' and '1e1' are numeric-equal (tie). But '1e1' compared against '1x' falls back to string collation and says '1e1' < '1x', while '10' compared against '1x' also falls back to string collation but says '10' > '1x' — so two values considered EQUAL to each other ('10' ~ '1e1') land on opposite sides of a third value ('1x'). Expected: a comparator used with Array.sort must be a consistent total order — if compare(A,B)===0 then compare(A,C) and compare(B,C) must agree in sign for every C. Location: src/core/sort.ts compareCells() — it re-derives numeric-vs-string mode per pair instead of computing one canonical sort key per cell up front.",
    () => {
      const headers = ["v"];
      // Row input order matters here: V8's sort implementation only
      // surfaces the inconsistency for certain input orderings (Array.sort
      // has no obligation to fully explore all pairwise comparisons), so
      // this exact order ["10", "1x", "1e1"] is chosen because it
      // empirically produces a visibly wrong result.
      const rows = [["10"], ["1x"], ["1e1"]];
      const sorted = sortRows(rows, headers, [{ column: "v", direction: "asc" }]);
      // A valid total order sorted ascending must place '1x' consistently
      // relative to '10' and '1e1' (which tie numerically at 10). Assert the
      // actually-consistent invariant: since '10' ~ '1e1' (equal keys), they
      // must be adjacent (stable, original order) and both on the same side
      // of '1x'. The buggy comparator instead sorts '1x' between them.
      const idx10 = sorted.findIndex((r) => r[0] === "10");
      const idx1e1 = sorted.findIndex((r) => r[0] === "1e1");
      const idx1x = sorted.findIndex((r) => r[0] === "1x");
      const bothSideOf1x = (idx10 < idx1x) === (idx1e1 < idx1x);
      expect(bothSideOf1x).toBe(true);
    },
  );

  test.fails(
    "BUG: same non-transitivity, demonstrated as a direct comparator-sign contradiction rather than via sortRows' output, using the exact algorithm copied from compareCells() (numeric parse mirrors src/core/sort.ts parseNumeric). '10'~'1e1' (tie) yet '1e1'<'1x' while '10'>'1x'. Expected: sign(cmp(A,C)) === sign(cmp(B,C)) whenever cmp(A,B) === 0.",
    () => {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      function parseNumeric(value: string): number | null {
        const trimmed = value.trim();
        if (trimmed === "") return null;
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : null;
      }
      function cmp(a: string, b: string): number {
        const aNum = parseNumeric(a);
        const bNum = parseNumeric(b);
        return aNum !== null && bNum !== null ? aNum - bNum : collator.compare(a, b);
      }
      const A = "10";
      const B = "1e1";
      const C = "1x";
      expect(cmp(A, B)).toBe(0); // numeric tie
      const ac = Math.sign(cmp(A, C));
      const bc = Math.sign(cmp(B, C));
      expect(ac).toBe(bc);
    },
  );

  it("property: hunts for transitivity violations across random mixes of numbers, numeric-looking strings, text, and empties, using the exact comparator logic mirrored from src/core/sort.ts compareCells(); currently expected to find some (the bug documented above), so this test reports the count rather than hard-asserting zero — it exists to prove the bug is systemic, not a cherry-picked triple", () => {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    function parseNumeric(value: string): number | null {
      const trimmed = value.trim();
      if (trimmed === "") return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    function cmp(a: string, b: string): number {
      const aNum = parseNumeric(a);
      const bNum = parseNumeric(b);
      return aNum !== null && bNum !== null ? aNum - bNum : collator.compare(a, b);
    }
    const pool = ["10", "9", "1e1", "abc", "-5", "0x1", "1x", "15x", "0x10", "1,000", "20", "abc2", "ABC"];
    function sign(x: number): number {
      return x === 0 ? 0 : x > 0 ? 1 : -1;
    }
    let violations = 0;
    for (const A of pool) {
      for (const B of pool) {
        for (const C of pool) {
          if (A === B || B === C || A === C) continue;
          const ab = sign(cmp(A, B));
          const bc = sign(cmp(B, C));
          const ac = sign(cmp(A, C));
          const isTransitive = !((ab <= 0 && bc <= 0 && ac > 0) || (ab >= 0 && bc >= 0 && ac < 0));
          if (!isTransitive) violations++;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`sort comparator transitivity violations found over ${pool.length}^3 triples:`, violations);
    expect(violations).toBeGreaterThan(0); // documents that the bug above is real and not cherry-picked
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

          // Empties are always the trailing `emptyCount` entries, in both directions.
          expect(asc.slice(asc.length - emptyCount).every((v) => v.trim() === "")).toBe(true);
          expect(desc.slice(desc.length - emptyCount).every((v) => v.trim() === "")).toBe(true);

          // The non-empty portions are exact reverses of each other.
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
            expect(new Set(columns).size).toBe(columns.length); // no duplicates
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
    console.log(`sortRows: 500k rows x 20 cols, 3 sort keys: ${ms.toFixed(1)}ms${ms > 1000 ? "  <-- OVER 1s, UI-freeze risk (main-thread sort, no chunking/yielding)" : ""}`);
    expect(sorted.length).toBe(N);
  }, 30000);
});
