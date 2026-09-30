import { describe, expect, it } from "vitest";
import { cycleSortForColumn, sortRows } from "../core/sort";
import type { SortKey } from "../core/types";

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
