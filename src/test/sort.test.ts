import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildColumnSortKeys, cellSortKey, compareCellSortKeys, cycleSortForColumn, sortRowIdsByCachedKeys, sortRows } from "../core/sort";
import type { SortDirection, SortKey } from "../core/types";

const headers = ["name", "age", "score"];

describe("numeric vs string comparison", () => {
  it("sorts numeric columns numerically, not lexicographically", () => {
    const rows = [["a", "9"], ["b", "10"], ["c", "2"]];
    const sorted = sortRows(rows, headers, [{ column: "age", direction: "asc" }]);
    expect(sorted.map((r) => r[1])).toEqual(["2", "9", "10"]);
  });

  it("sorts non-numeric columns with localeCompare numeric-aware ordering", () => {
    const rows = [["item10"], ["item2"], ["item1"]];
    const sorted = sortRows(rows, ["name"], [{ column: "name", direction: "asc" }]);
    expect(sorted.map((r) => r[0])).toEqual(["item1", "item2", "item10"]);
  });

  it("compares each pair on its own merits: numeric vs numeric compares as numbers, either side non-numeric falls back to string comparison", () => {
    const rows = [["10"], ["abc"], ["2"]];
    const sorted = sortRows(rows, ["v"], [{ column: "v", direction: "asc" }]);
    // "2" vs "10" are both numeric (2 < 10). Either paired with "abc" falls
    // back to localeCompare, where "10" and "2" both precede "abc".
    expect(sorted.map((r) => r[0])).toEqual(["2", "10", "abc"]);
  });
});

describe("empty cells", () => {
  it("sort last in ascending order", () => {
    const rows = [["3"], [""], ["1"]];
    const sorted = sortRows(rows, ["v"], [{ column: "v", direction: "asc" }]);
    expect(sorted.map((r) => r[0])).toEqual(["1", "3", ""]);
  });

  it("sort last in descending order too", () => {
    const rows = [["3"], [""], ["1"]];
    const sorted = sortRows(rows, ["v"], [{ column: "v", direction: "desc" }]);
    expect(sorted.map((r) => r[0])).toEqual(["3", "1", ""]);
  });

  it("whitespace-only cells count as empty", () => {
    const rows = [["3"], ["  "], ["1"]];
    const sorted = sortRows(rows, ["v"], [{ column: "v", direction: "asc" }]);
    expect(sorted.map((r) => r[0])).toEqual(["1", "3", "  "]);
  });
});

describe("stability", () => {
  it("preserves original order for equal keys", () => {
    const rows = [
      ["A", "1"],
      ["B", "1"],
      ["C", "1"],
    ];
    const sorted = sortRows(rows, headers, [{ column: "age", direction: "asc" }]);
    expect(sorted.map((r) => r[0])).toEqual(["A", "B", "C"]);
  });
});

describe("multi-key sort", () => {
  it("sorts by the second key to break ties on the first", () => {
    const rows = [
      ["a", "1", "9"],
      ["b", "1", "2"],
      ["c", "2", "5"],
    ];
    const keys: SortKey[] = [
      { column: "age", direction: "asc" },
      { column: "score", direction: "asc" },
    ];
    const sorted = sortRows(rows, headers, keys);
    expect(sorted.map((r) => r[0])).toEqual(["b", "a", "c"]);
  });
});

describe("no sort keys", () => {
  it("returns rows in original order", () => {
    const rows = [["b"], ["a"]];
    expect(sortRows(rows, ["v"], [])).toEqual(rows);
  });
});

describe("cycleSortForColumn", () => {
  it("single click cycles none -> asc -> desc -> none", () => {
    let keys: SortKey[] = [];
    keys = cycleSortForColumn(keys, "name", false);
    expect(keys).toEqual([{ column: "name", direction: "asc" }]);
    keys = cycleSortForColumn(keys, "name", false);
    expect(keys).toEqual([{ column: "name", direction: "desc" }]);
    keys = cycleSortForColumn(keys, "name", false);
    expect(keys).toEqual([]);
  });

  it("a plain click on a different column replaces the sort entirely", () => {
    let keys: SortKey[] = [{ column: "name", direction: "asc" }];
    keys = cycleSortForColumn(keys, "age", false);
    expect(keys).toEqual([{ column: "age", direction: "asc" }]);
  });

  it("shift+click adds a secondary key without disturbing the first", () => {
    let keys: SortKey[] = [{ column: "name", direction: "asc" }];
    keys = cycleSortForColumn(keys, "age", true);
    expect(keys).toEqual([
      { column: "name", direction: "asc" },
      { column: "age", direction: "asc" },
    ]);
  });

  it("shift+click cycles an existing secondary key through desc then removes it", () => {
    let keys: SortKey[] = [
      { column: "name", direction: "asc" },
      { column: "age", direction: "asc" },
    ];
    keys = cycleSortForColumn(keys, "age", true);
    expect(keys).toEqual([
      { column: "name", direction: "asc" },
      { column: "age", direction: "desc" },
    ]);
    keys = cycleSortForColumn(keys, "age", true);
    expect(keys).toEqual([{ column: "name", direction: "asc" }]);
  });
});

describe("collator ties", () => {
  it("keeps values the collator treats as equal (case variants) in original row order", () => {
    const rows = [["a", "0"], ["A", "1"], ["b", "2"], ["a", "3"]];
    const sorted = sortRows(rows, ["v", "i"], [{ column: "v", direction: "asc" }]);
    expect(sorted.map((r) => r[1])).toEqual(["0", "1", "3", "2"]);
  });

  it("lets a later sort key break a case-variant tie", () => {
    const rows = [["a", "2"], ["A", "1"]];
    const sorted = sortRows(rows, ["v", "n"], [
      { column: "v", direction: "asc" },
      { column: "n", direction: "asc" },
    ]);
    expect(sorted.map((r) => r[1])).toEqual(["1", "2"]);
  });
});

// buildColumnSortKeys/sortRowIdsByCachedKeys are the primitives the worker
// caches per column to avoid re-deriving a column's sort keys (including
// the collator-ranking pass) on every query — see worker.ts. sortRows
// itself is now implemented in terms of them, so any accidental behavior
// drift between the two would show up as a sortRows regression too; these
// tests additionally cover the specific reuse the cache depends on:
// keys built once over the FULL dataset must still order any filtered
// SUBSET (by id) identically to sorting that subset directly.
describe("buildColumnSortKeys / sortRowIdsByCachedKeys (worker sort-key cache primitives)", () => {
  it("sorting the full dataset via the cached-key path matches sortRows exactly", () => {
    const rows = [["a", "30"], ["b", "10"], ["c", "20"], ["d", "10"]];
    const expected = sortRows(rows, ["name", "age"], [{ column: "age", direction: "asc" }]);

    const ageKeys = buildColumnSortKeys(rows, 1);
    const order = sortRowIdsByCachedKeys(
      rows.map((_, i) => i),
      [{ direction: "asc", keys: ageKeys }],
    );
    expect(order.map((i) => rows[i])).toEqual(expected);
  });

  it("keeps collator-tied case variants in original row order, same as sortRows", () => {
    const rows = [["a", "0"], ["A", "1"], ["b", "2"], ["a", "3"]];
    const expected = sortRows(rows, ["v", "i"], [{ column: "v", direction: "asc" }]);

    const vKeys = buildColumnSortKeys(rows, 0);
    const order = sortRowIdsByCachedKeys(
      rows.map((_, i) => i),
      [{ direction: "asc", keys: vKeys }],
    );
    expect(order.map((i) => rows[i])).toEqual(expected);
  });

  it("multi-key: a later cached column breaks a tie on an earlier one, same as sortRows", () => {
    const rows = [["a", "2"], ["A", "1"]];
    const expected = sortRows(rows, ["v", "n"], [
      { column: "v", direction: "asc" },
      { column: "n", direction: "asc" },
    ]);

    const vKeys = buildColumnSortKeys(rows, 0);
    const nKeys = buildColumnSortKeys(rows, 1);
    const order = sortRowIdsByCachedKeys(
      rows.map((_, i) => i),
      [
        { direction: "asc", keys: vKeys },
        { direction: "asc", keys: nKeys },
      ],
    );
    expect(order.map((i) => rows[i])).toEqual(expected);
  });

  it("keys built once over the FULL dataset still order a filtered SUBSET identically to sorting that subset directly — the exact reuse the worker's sort-key cache relies on", () => {
    const rows = [["banana"], ["Apple"], ["cherry"], ["apple"], ["Banana"], ["date"]];
    // Keep only these ids (in original relative order) — mimics what
    // applyFilters would hand back for some filter.
    const keptIds = [0, 2, 3, 5];
    const subsetRows = keptIds.map((id) => rows[id]);
    const direction: SortDirection = "asc";
    const expected = sortRows(subsetRows, ["v"], [{ column: "v", direction }]);

    // Cache built over the FULL dataset once, then reused for the subset by id.
    const globalKeys = buildColumnSortKeys(rows, 0);
    const order = sortRowIdsByCachedKeys(keptIds, [{ direction, keys: globalKeys }]);
    expect(order.map((id) => rows[id])).toEqual(expected);
  });

  it("no sort keys returns the ids unchanged, same as sortRows returning rows unchanged", () => {
    const ids = [3, 1, 4];
    expect(sortRowIdsByCachedKeys(ids, [])).toEqual(ids);
  });

  it("property (fast-check): sort keys built once over the FULL dataset, then restricted to a random subset of ids, order that subset identically to calling sortRows directly on it", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("a", "A", "b", "B", "1", "2", "10", "1e1", "", "  ", "xyz"),
            fc.constantFrom("1", "2", "3", "10", "abc", ""),
            fc.boolean(), // whether this row survives into the "filtered" subset
          ),
          { minLength: 1, maxLength: 15 },
        ),
        fc.constantFrom<SortDirection>("asc", "desc"),
        (rowTuples, direction) => {
          const rows = rowTuples.map(([v, n]) => [v, n]);
          const headers = ["v", "n"];
          const keys: SortKey[] = [
            { column: "v", direction },
            { column: "n", direction },
          ];

          let keptIds = rows.map((_, i) => i).filter((i) => rowTuples[i][2]);
          if (keptIds.length === 0) keptIds = [0]; // keep the subset non-empty
          const subsetRows = keptIds.map((id) => rows[id]);

          const expected = sortRows(subsetRows, headers, keys);

          const vKeys = buildColumnSortKeys(rows, 0);
          const nKeys = buildColumnSortKeys(rows, 1);
          const order = sortRowIdsByCachedKeys(keptIds, [
            { direction, keys: vKeys },
            { direction, keys: nKeys },
          ]);
          const actual = order.map((id) => rows[id]);

          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("mostly-unique text columns (index-sort ranking path)", () => {
  // Above 20,000 distinct text values buildColumnSortKeys ranks by sorting
  // row indexes instead of hashing strings. It must order exactly like a
  // plain stable sort with the per-pair comparator.
  const rows: string[][] = [];
  for (let i = 0; i < 30_000; i++) {
    const n = (i * 7919) % 26_000; // > 20k distinct, with repeats
    let value: string;
    if (i % 97 === 0) value = "";
    else if (i % 53 === 0) value = String(n); // numeric cells mixed in
    else value = i % 2 === 0 ? `Name ${n}` : `name ${n}`; // collator-equal case variants
    rows.push([value, String(i)]);
  }
  rows.push(["Zeta tie", "30000"], ["zeta TIE", "30001"]);

  for (const direction of ["asc", "desc"] as const) {
    it(`matches a reference stable sort (${direction})`, () => {
      const reference = rows
        .map((row, i) => ({ row, i, key: cellSortKey(row[0]) }))
        .sort((x, y) => compareCellSortKeys(x.key, y.key, direction) || x.i - y.i)
        .map((e) => e.row[1]);

      const sorted = sortRows(rows, ["v", "i"], [{ column: "v", direction }]);
      expect(sorted.map((r) => r[1])).toEqual(reference);
    });
  }

  it("gives collator-equal values the same rank so a second key can break the tie", () => {
    const keys = buildColumnSortKeys(rows, 0);
    const a = rows.findIndex((r) => r[0] === "Zeta tie");
    const b = rows.findIndex((r) => r[0] === "zeta TIE");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(keys[a].rank).toBe(keys[b].rank);
  });
});
