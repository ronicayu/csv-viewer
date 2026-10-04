import { describe, expect, it } from "vitest";
import { applyFilters, isRuleActive, isValidRule } from "../core/filter";
import type { FilterRule } from "../core/types";

const headers = ["name", "age", "city"];
const rows = [
  ["Alice", "30", "NYC"],
  ["bob", "25", ""],
  ["Charlie", "notanumber", "LA"],
  ["", "40", "SF"],
];

function rule(overrides: Partial<FilterRule>): FilterRule {
  return {
    id: "r1",
    column: "name",
    operator: "contains",
    value: "",
    mode: "include",
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

describe("quick search", () => {
  it("matches case-insensitively across all columns", () => {
    const result = applyFilters(headers, rows, "nyc", []);
    expect(result).toEqual([["Alice", "30", "NYC"]]);
  });

  it("empty search returns all rows", () => {
    expect(applyFilters(headers, rows, "", [])).toEqual(rows);
  });
});

describe("operator: contains/equals/startsWith/endsWith", () => {
  it("contains, case-insensitive by default", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "contains", value: "har" })]);
    expect(result).toEqual([["Charlie", "notanumber", "LA"]]);
  });

  it("contains is case-sensitive when caseSensitive is set", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "contains", value: "Har", caseSensitive: true })]);
    expect(result).toEqual([]);
  });

  it("equals matches the whole cell", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "equals", value: "bob" })]);
    expect(result).toEqual([["bob", "25", ""]]);
  });

  it("startsWith", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "startsWith", value: "Al" })]);
    expect(result).toEqual([["Alice", "30", "NYC"]]);
  });

  it("endsWith", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "endsWith", value: "lie" })]);
    expect(result).toEqual([["Charlie", "notanumber", "LA"]]);
  });
});

describe("operator: regex", () => {
  it("matches a valid regex", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "regex", value: "^A" })]);
    expect(result).toEqual([["Alice", "30", "NYC"]]);
  });

  it("an invalid regex rule is ignored (never crashes, no effect on results)", () => {
    expect(() => applyFilters(headers, rows, "", [rule({ operator: "regex", value: "(unterminated" })])).not.toThrow();
    const result = applyFilters(headers, rows, "", [rule({ operator: "regex", value: "(unterminated" })]);
    expect(result).toEqual(rows);
  });

  it("isValidRule flags an invalid regex", () => {
    expect(isValidRule(rule({ operator: "regex", value: "(unterminated" }))).toBe(false);
    expect(isValidRule(rule({ operator: "regex", value: "^A" }))).toBe(true);
  });
});

describe("operator: isEmpty", () => {
  it("matches empty cells", () => {
    const result = applyFilters(headers, rows, "", [rule({ column: "city", operator: "isEmpty", value: "" })]);
    expect(result).toEqual([["bob", "25", ""]]);
  });
});

describe("numeric operators", () => {
  it("gt compares as numbers", () => {
    const result = applyFilters(headers, rows, "", [rule({ column: "age", operator: "gt", value: "28" })]);
    expect(result).toEqual([
      ["Alice", "30", "NYC"],
      ["", "40", "SF"],
    ]);
  });

  it("lt compares as numbers", () => {
    const result = applyFilters(headers, rows, "", [rule({ column: "age", operator: "lt", value: "28" })]);
    expect(result).toEqual([["bob", "25", ""]]);
  });

  it("gte and lte are inclusive", () => {
    expect(applyFilters(headers, rows, "", [rule({ column: "age", operator: "gte", value: "30" })])).toEqual([
      ["Alice", "30", "NYC"],
      ["", "40", "SF"],
    ]);
    expect(applyFilters(headers, rows, "", [rule({ column: "age", operator: "lte", value: "25" })])).toEqual([
      ["bob", "25", ""],
    ]);
  });

  it("a non-numeric cell fails a numeric rule (row excluded when included)", () => {
    const result = applyFilters(headers, rows, "", [rule({ column: "age", operator: "gt", value: "0" })]);
    expect(result).not.toContainEqual(["Charlie", "notanumber", "LA"]);
  });
});

describe("any-column rule", () => {
  it("matches if any cell in the row matches", () => {
    const result = applyFilters(headers, rows, "", [rule({ column: null, operator: "equals", value: "LA" })]);
    expect(result).toEqual([["Charlie", "notanumber", "LA"]]);
  });
});

describe("include vs exclude mode", () => {
  it("include mode keeps only matching rows", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "startsWith", value: "A", mode: "include" })]);
    expect(result).toEqual([["Alice", "30", "NYC"]]);
  });

  it("exclude mode drops matching rows", () => {
    const result = applyFilters(headers, rows, "", [rule({ column: "city", operator: "equals", value: "LA", mode: "exclude" })]);
    expect(result).toEqual([
      ["Alice", "30", "NYC"],
      ["bob", "25", ""],
      ["", "40", "SF"],
    ]);
  });
});

describe("disabled rules", () => {
  it("a disabled rule has no effect", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "equals", value: "bob", enabled: false })]);
    expect(result).toEqual(rows);
  });
});

describe("AND semantics across multiple rules", () => {
  it("all enabled include rules must match, and any matching exclude rule drops the row", () => {
    const rules: FilterRule[] = [
      rule({ column: "age", operator: "gt", value: "0", mode: "include" }),
      rule({ column: "city", operator: "equals", value: "LA", mode: "exclude" }),
    ];
    const result = applyFilters(headers, rows, "", rules);
    expect(result).toEqual([
      ["Alice", "30", "NYC"],
      ["bob", "25", ""],
      ["", "40", "SF"],
    ]);
  });
});

describe("isRuleActive: the single source of truth applyFilters and the UI both use for 'will this rule do anything'", () => {
  it("is false for an invalid regex", () => {
    expect(isRuleActive(rule({ operator: "regex", value: "(unterminated" }), headers)).toBe(false);
  });

  it("is false when the rule's column no longer exists in headers", () => {
    expect(isRuleActive(rule({ column: "ghost", operator: "equals", value: "x" }), headers)).toBe(false);
  });

  it("is true for an any-column rule (column: null), regardless of headers", () => {
    expect(isRuleActive(rule({ column: null, operator: "equals", value: "x" }), headers)).toBe(true);
  });

  it("is false for a value-taking operator with an empty value", () => {
    expect(isRuleActive(rule({ operator: "contains", value: "" }), headers)).toBe(false);
    expect(isRuleActive(rule({ operator: "gt", value: "" }), headers)).toBe(false);
  });

  it("is true for isEmpty even with an empty value, since isEmpty takes no value", () => {
    expect(isRuleActive(rule({ operator: "isEmpty", value: "" }), headers)).toBe(true);
  });

  it("is true for an otherwise-well-formed rule", () => {
    expect(isRuleActive(rule({ column: "age", operator: "gt", value: "10" }), headers)).toBe(true);
  });

  it("agrees with applyFilters: a rule isRuleActive says is inactive has zero effect either way (include leaves rows as-is, exclude drops nothing)", () => {
    const inactiveRules: FilterRule[] = [
      rule({ column: "ghost", operator: "equals", value: "x", mode: "include" }),
      rule({ operator: "contains", value: "", mode: "exclude" }),
    ];
    for (const r of inactiveRules) {
      expect(isRuleActive(r, headers)).toBe(false);
      expect(applyFilters(headers, rows, "", [r])).toEqual(rows);
    }
  });
});

describe("operator: in (is any of)", () => {
  const inHeaders = ["name", "tag"];
  const inRows: string[][] = [
    ["r1", "red"],
    ["r2", "Red"],
    ["r3", " red"],
    ["r4", "blue"],
    ["r5", ""],
    ["r6"],
    ["r7", "__proto__"],
  ];
  const names = (out: string[][]): string[] => out.map((r) => r[0]);
  const inRule = (values: string[] | undefined, overrides: Partial<FilterRule> = {}): FilterRule =>
    rule({ column: "tag", operator: "in", values, ...overrides });

  it("include (Keep) keeps only rows whose cell is exactly one of the values", () => {
    expect(names(applyFilters(inHeaders, inRows, "", [inRule(["red", "blue"])]))).toEqual(["r1", "r4"]);
  });

  it("exclude (Hide) drops those rows and keeps the rest", () => {
    expect(names(applyFilters(inHeaders, inRows, "", [inRule(["red", "blue"], { mode: "exclude" })]))).toEqual([
      "r2",
      "r3",
      "r5",
      "r6",
      "r7",
    ]);
  });

  it("is case-exact: 'red' does not match 'Red', whatever caseSensitive says", () => {
    expect(names(applyFilters(inHeaders, inRows, "", [inRule(["Red"], { caseSensitive: false })]))).toEqual(["r2"]);
    expect(names(applyFilters(inHeaders, inRows, "", [inRule(["Red"], { caseSensitive: true })]))).toEqual(["r2"]);
  });

  it("does not trim: ' red' and 'red' are different values", () => {
    expect(names(applyFilters(inHeaders, inRows, "", [inRule([" red"])]))).toEqual(["r3"]);
  });

  it("'' in values matches empty cells, including a missing cell in a ragged row", () => {
    expect(names(applyFilters(inHeaders, inRows, "", [inRule([""])]))).toEqual(["r5", "r6"]);
    expect(names(applyFilters(inHeaders, inRows, "", [inRule(["", "blue"], { mode: "exclude" })]))).toEqual([
      "r1",
      "r2",
      "r3",
      "r7",
    ]);
  });

  it("matches Object.prototype-ish values like any other string", () => {
    expect(names(applyFilters(inHeaders, inRows, "", [inRule(["__proto__"])]))).toEqual(["r7"]);
    expect(names(applyFilters(inHeaders, inRows, "", [inRule(["constructor", "toString"])]))).toEqual([]);
  });

  it("ignores `value` (a stale value from another condition has no effect)", () => {
    expect(names(applyFilters(inHeaders, inRows, "", [inRule(["blue"], { value: "red" })]))).toEqual(["r4"]);
  });

  it("combines with other rules and quick search by AND", () => {
    const rules = [inRule(["red", "Red", "blue"]), rule({ column: "name", operator: "equals", value: "r2", mode: "exclude" })];
    expect(names(applyFilters(inHeaders, inRows, "", rules))).toEqual(["r1", "r4"]);
    expect(names(applyFilters(inHeaders, inRows, "blue", [inRule(["red", "blue"])]))).toEqual(["r4"]);
  });

  it("a missing or undefined `values` (state saved before this operator) is inactive and filters nothing", () => {
    for (const r of [inRule(undefined), inRule(undefined, { mode: "exclude" })]) {
      expect(isRuleActive(r, inHeaders)).toBe(false);
      expect(applyFilters(inHeaders, inRows, "", [r])).toEqual(inRows);
    }
  });

  it("builds its lookup once per call and tolerates a large values list", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `v${i}`);
    const rowsMany = many.map((v) => [v, v]);
    expect(applyFilters(inHeaders, rowsMany, "", [inRule(many.slice(0, 10))])).toHaveLength(10);
  });
});

describe("isRuleActive for the in operator", () => {
  const inRule = (overrides: Partial<FilterRule>): FilterRule =>
    rule({ column: "city", operator: "in", value: "", values: ["NYC"], ...overrides });

  it("is true for a specific, existing column with a non-empty values list (an empty `value` does not matter)", () => {
    expect(isRuleActive(inRule({}), headers)).toBe(true);
    expect(isRuleActive(inRule({ values: [""] }), headers)).toBe(true);
  });

  it("is false for an empty or missing values list", () => {
    expect(isRuleActive(inRule({ values: [] }), headers)).toBe(false);
    expect(isRuleActive(inRule({ values: undefined }), headers)).toBe(false);
  });

  it("is false for 'Any column', even with values", () => {
    expect(isRuleActive(inRule({ column: null }), headers)).toBe(false);
  });

  it("is false when the column is not in the file", () => {
    expect(isRuleActive(inRule({ column: "ghost" }), headers)).toBe(false);
  });

  it("agrees with applyFilters: every inactive in rule has zero effect, in both modes", () => {
    const inactive: Partial<FilterRule>[] = [{ values: [] }, { values: undefined }, { column: null }, { column: "ghost" }];
    for (const overrides of inactive) {
      for (const mode of ["include", "exclude"] as const) {
        const r = inRule({ ...overrides, mode });
        expect(isRuleActive(r, headers)).toBe(false);
        expect(applyFilters(headers, rows, "", [r])).toEqual(rows);
      }
    }
  });

  it("agrees with applyFilters: an active in rule changes the result", () => {
    const r = inRule({ column: "city", values: ["NYC"] });
    expect(isRuleActive(r, headers)).toBe(true);
    expect(applyFilters(headers, rows, "", [r])).toEqual([["Alice", "30", "NYC"]]);
  });
});
