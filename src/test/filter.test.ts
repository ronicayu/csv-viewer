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
    // "Charlie" fails the numeric include rule (non-numeric age); LA is excluded too.
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
