// Adversarial tests for src/core/filter.ts. Bugs found are documented with
// test.fails(...) plus a comment stating the expected correct behavior, so
// the suite stays green while the gap is visible. Everything else here is a
// real (passing) assertion about current behavior — either confirming a
// design decision is safe, or documenting a surprising-but-arguably-OK edge
// case that a product owner should be aware of but that isn't a bug per se.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyFilters, isValidRule } from "../../core/filter";
import type { FilterRule } from "../../core/types";

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

describe("empty rule value", () => {
  const headers = ["name"];
  const rows = [["Alice"], [""], ["  "]];

  // Changed behavior (bug fix, decision #10, not a regression): a
  // value-taking rule (every operator except isEmpty, which takes no
  // value) with an empty value is now IGNORED — as if disabled — rather
  // than applied with whatever incidental behavior its operator happens
  // to have on "". For contains/startsWith/endsWith in include mode, that
  // incidental behavior (match-everything, via JS String semantics) was
  // already indistinguishable from "ignored", so nothing here changes.
  // But the SAME incidental behavior in exclude mode used to be
  // "drop everything", which is now, correctly, "ignored" (drop nothing) —
  // see isRuleActive in src/core/filter.ts.
  it("contains '' is ignored (ties to isRuleActive's 'needs a value' check) — has no effect in either include or exclude mode", () => {
    expect(applyFilters(headers, rows, "", [rule({ operator: "contains", value: "", mode: "include" })])).toEqual(rows);
    expect(applyFilters(headers, rows, "", [rule({ operator: "contains", value: "", mode: "exclude" })])).toEqual(rows);
  });

  it("startsWith/endsWith '' are likewise ignored, not applied", () => {
    expect(applyFilters(headers, rows, "", [rule({ operator: "startsWith", value: "" })])).toEqual(rows);
    expect(applyFilters(headers, rows, "", [rule({ operator: "endsWith", value: "" })])).toEqual(rows);
  });

  it("equals '' is ignored too — even though 'match only truly-empty cells' would have been a well-defined, useful behavior, the empty-value rule is inert like every other operator", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "equals", value: "" })]);
    expect(result).toEqual(rows);
  });

  it("isEmpty, the one operator that takes no value, is unaffected — an empty `value` field never disables it", () => {
    const result = applyFilters(headers, rows, "", [rule({ operator: "isEmpty", value: "" })]);
    expect(result).toEqual([[""], ["  "]]);
  });
});

describe("leading/trailing whitespace is significant for string operators (no implicit trim, unlike isEmpty/numeric)", () => {
  const headers = ["name"];
  const rows = [["Alice"], [" Alice"], ["Alice "], [" Alice "]];

  it("equals does not trim — only the exact cell matches", () => {
    expect(applyFilters(headers, rows, "", [rule({ operator: "equals", value: "Alice" })])).toEqual([["Alice"]]);
  });

  it("startsWith/endsWith are whitespace-sensitive too", () => {
    expect(applyFilters(headers, rows, "", [rule({ operator: "startsWith", value: "Alice" })])).toEqual([
      ["Alice"],
      ["Alice "],
    ]);
    expect(applyFilters(headers, rows, "", [rule({ operator: "endsWith", value: "Alice" })])).toEqual([
      ["Alice"],
      [" Alice"],
    ]);
  });
});

describe("Unicode case folding via toLowerCase()", () => {
  it("Greek final-sigma casing is handled correctly by JS toLowerCase (not a bug — documenting it works)", () => {
    // ΟΔΟΣ (all-caps "street") lowercases to οδος using final sigma ς, matching
    // a rule value typed in ordinary lowercase Greek.
    const headers = ["word"];
    const rows = [["ΟΔΟΣ"]];
    expect(applyFilters(headers, rows, "", [rule({ column: "word", operator: "equals", value: "οδος" })])).toEqual(rows);
  });

  // Changed behavior (bug fix, decision #8, not a regression): case-
  // insensitive matching now goes through a shared `foldCase` (src/core/
  // caseFold.ts) instead of plain `toLowerCase()`. foldCase explicitly
  // folds "ß" to "ss", so this test's original "expected" (that ß case-
  // folding was out of scope) now conflicts with that decision — updated
  // to assert the fix instead.
  it("German ß now case-folds to 'ss' via the shared foldCase, so STRASSE matches straße case-insensitively", () => {
    const headers = ["word"];
    const rows = [["straße"]];
    expect(applyFilters(headers, rows, "", [rule({ column: "word", operator: "equals", value: "STRASSE" })])).toEqual(rows);
  });

  // FIXED: foldCase (src/core/caseFold.ts) drops the combining dot above
  // (U+0307) that toLowerCase("İ") leaves behind, so a case-insensitive
  // rule value containing Turkish İ matches ordinary lowercase "i" text.
  it("case-insensitive 'contains' matches plain 'i' against Turkish İ (U+0130) via the shared foldCase", () => {
    const headers = ["city"];
    const rows = [["istanbul"]];
    const result = applyFilters(headers, rows, "", [
      rule({ column: "city", operator: "contains", value: "İstanbul", caseSensitive: false }),
    ]);
    expect(result).toEqual(rows);
  });

  it("case-insensitive equals is now reflexive: 'İstanbul' matches a rule value of 'istanbul' (same word, ordinary casing)", () => {
    const headers = ["city"];
    const rows = [["İstanbul"]];
    const result = applyFilters(headers, rows, "", [
      rule({ column: "city", operator: "equals", value: "istanbul", caseSensitive: false }),
    ]);
    expect(result).toEqual(rows);
  });
});

describe("regex: anchors and flags", () => {
  const headers = ["v"];

  it("^ and $ anchor to the whole string, not per-line (no 'm' flag ever applied)", () => {
    const rows = [["abc\ndef"]];
    // Without the 'm' flag, ^ only matches the very start, $ the very end
    // (or just before a trailing \n) — "def" in the middle of the string
    // does not match ^def$.
    expect(applyFilters(headers, rows, "", [rule({ column: "v", operator: "regex", value: "^def$" })])).toEqual([]);
  });

  it("case-sensitive toggle controls whether the 'i' flag is added, not literal 'i' in the pattern", () => {
    const rows = [["ABC"]];
    expect(
      applyFilters(headers, rows, "", [rule({ column: "v", operator: "regex", value: "^abc$", caseSensitive: false })]),
    ).toEqual(rows);
    expect(
      applyFilters(headers, rows, "", [rule({ column: "v", operator: "regex", value: "^abc$", caseSensitive: true })]),
    ).toEqual([]);
  });

  it("an invalid pattern makes the rule inert (isValidRule false, applyFilters ignores it, never throws)", () => {
    const rows = [["anything"]];
    const bad = rule({ column: "v", operator: "regex", value: "[unterminated" });
    expect(isValidRule(bad)).toBe(false);
    expect(() => applyFilters(headers, rows, "", [bad])).not.toThrow();
    expect(applyFilters(headers, rows, "", [bad])).toEqual(rows);
  });

  it("the compiled RegExp is never given the 'g' flag, so repeated calls never leak lastIndex state across rows or across calls (regression guard: if 'g' were ever added, re.test() would silently skip alternating matches)", () => {
    const rows = [["match"], ["match"], ["match"], ["match"]];
    const rules = [rule({ column: "v", operator: "regex", value: "match" })];
    const first = applyFilters(headers, rows, "", rules);
    const second = applyFilters(headers, rows, "", rules);
    // Idempotent: every row matches every time, both within one call across
    // multiple rows sharing the same compiled RegExp object, and across
    // repeated calls with the same rule object.
    expect(first).toEqual(rows);
    expect(second).toEqual(rows);
  });

  it("demonstrates the 'g'-flag lastIndex trap directly on RegExp.test (illustrative — not reachable through this codebase's public API, since compileRule never adds 'g', but documents why that omission matters)", () => {
    const g = /a/g;
    const results = [g.test("a"), g.test("a"), g.test("a")];
    // A stateful global regex alternates match/no-match because lastIndex
    // persists on the RegExp object between calls to test(). This is why
    // src/core/filter.ts must never compile rule regexes with 'g'.
    expect(results).toEqual([true, false, true]);
  });

  describe("catastrophic backtracking (UI-freeze risk)", () => {
    it("(a+)+$ on a short pathological string does not resolve within 2s — confirmed via a subprocess with a hard timeout so this test itself cannot hang the suite", () => {
      const script = `
        const re = new RegExp("(a+)+$", "i");
        const cell = "a".repeat(30) + "b";
        re.test(cell);
        console.log("finished");
      `;
      let timedOut = false;
      try {
        execFileSync(process.execPath, ["-e", script], { timeout: 2000, stdio: "pipe" });
      } catch (err) {
        // ETIMEDOUT / SIGTERM confirms the regex engine was still
        // backtracking after 2 full seconds on a 31-character cell.
        timedOut = true;
      }
      expect(timedOut).toBe(true);
    }, 5000);

    it("times a range of input sizes to show the exponential blowup (bounded via subprocess timeout so the suite stays fast); reported in the final timing table", () => {
      const timings: Record<number, string> = {};
      for (const n of [10, 15, 18, 20]) {
        const script = `
          const re = new RegExp("(a+)+$", "i");
          const cell = "a".repeat(${n}) + "b";
          const start = Date.now();
          re.test(cell);
          console.log(Date.now() - start);
        `;
        const startWall = Date.now();
        try {
          const out = execFileSync(process.execPath, ["-e", script], { timeout: 3000, stdio: "pipe" }).toString().trim();
          timings[n] = `${out}ms`;
        } catch {
          timings[n] = `>${Date.now() - startWall}ms (killed)`;
        }
      }
      // eslint-disable-next-line no-console
      console.log("catastrophic backtracking timings, (a+)+$ on n a's + 'b':", timings);
      expect(true).toBe(true);
    }, 20000);
  });
});

describe("numeric operators: what Number() actually accepts", () => {
  const headers = ["v"];

  it("'1e3' is accepted as scientific notation (1000) — arguably fine, spreadsheet-like", () => {
    expect(applyFilters(headers, [["1e3"]], "", [rule({ column: "v", operator: "gt", value: "999" })])).toEqual([
      ["1e3"],
    ]);
  });

  // FIXED: the shared parseNumber (src/core/number.ts) only accepts a
  // strict decimal-number pattern, so '0x10' is no longer silently parsed
  // as hex (16) the way plain Number('0x10') === 16 would — it's treated
  // as non-numeric, same as '12abc'.
  it("'0x10' is treated as non-numeric (rejected by the strict decimal pattern), not silently parsed as hex", () => {
    const result = applyFilters(headers, [["0x10"]], "", [rule({ column: "v", operator: "gt", value: "15" })]);
    expect(result).toEqual([]);
  });

  it("' 12 ' trims before Number() and parses to 12 for numeric operators — matches spec's documented trim-then-Number() rule, not a bug (note: this is 'equals'-as-a-numeric-value behavior via gte+lte, not the string 'equals' operator, which never trims)", () => {
    expect(applyFilters(headers, [[" 12 "]], "", [rule({ column: "v", operator: "gte", value: "12" })])).toEqual([
      [" 12 "],
    ]);
    expect(applyFilters(headers, [[" 12 "]], "", [rule({ column: "v", operator: "lte", value: "12" })])).toEqual([
      [" 12 "],
    ]);
  });

  it("'1,000' (thousands separator) is NOT numeric — Number('1,000') is NaN, so it fails every numeric rule; matches spec's explicit choice ('no thousands separators, plain Number()') — surprising to end users pasting spreadsheet exports, but intentional per docs/spec.md", () => {
    const result = applyFilters(headers, [["1,000"]], "", [rule({ column: "v", operator: "gt", value: "1" })]);
    expect(result).toEqual([]);
  });

  it("'-0' is a valid finite number and compares as 0 (IEEE-754 -0 == 0), not a bug", () => {
    expect(applyFilters(headers, [["-0"]], "", [rule({ column: "v", operator: "gte", value: "0" })])).toEqual([["-0"]]);
    expect(applyFilters(headers, [["-0"]], "", [rule({ column: "v", operator: "gt", value: "0" })])).toEqual([]);
  });

  it("'Infinity' and 'NaN' text are rejected as non-finite by Number.isFinite, so they never match a numeric rule — deliberate guard, not a bug", () => {
    expect(applyFilters(headers, [["Infinity"]], "", [rule({ column: "v", operator: "gt", value: "0" })])).toEqual([]);
    expect(applyFilters(headers, [["NaN"]], "", [rule({ column: "v", operator: "gt", value: "0" })])).toEqual([]);
  });

  it("'' (empty cell) never matches a numeric rule (parseNumeric special-cases the trimmed-empty string to null before calling Number)", () => {
    expect(applyFilters(headers, [[""]], "", [rule({ column: "v", operator: "gte", value: "-999999" })])).toEqual([]);
  });

  it("'12abc' does not partial-parse to 12 — Number() rejects any trailing garbage, so this correctly fails every numeric rule (reassuring, not a bug)", () => {
    expect(applyFilters(headers, [["12abc"]], "", [rule({ column: "v", operator: "gt", value: "0" })])).toEqual([]);
  });

  it("'$5' and '5%' are not stripped of their symbol, so neither is numeric — surprising for finance/percent columns pasted from spreadsheets, but no symbol-stripping is specified anywhere; arguably OK", () => {
    expect(applyFilters(headers, [["$5"]], "", [rule({ column: "v", operator: "gt", value: "0" })])).toEqual([]);
    expect(applyFilters(headers, [["5%"]], "", [rule({ column: "v", operator: "gt", value: "0" })])).toEqual([]);
  });

  it("a rule value itself that fails to parse numerically (e.g. the rule's own value is 'abc') makes the rule match nothing, for any cell — including cells that are themselves numeric", () => {
    expect(applyFilters(headers, [["5"]], "", [rule({ column: "v", operator: "gt", value: "abc" })])).toEqual([]);
  });
});

describe("isEmpty", () => {
  it("whitespace-only cells count as empty (trim() === '')", () => {
    const headers = ["v"];
    const rows = [[""], ["   "], ["\t\n"], ["x"]];
    const result = applyFilters(headers, rows, "", [rule({ column: "v", operator: "isEmpty", value: "" })]);
    expect(result).toEqual([[""], ["   "], ["\t\n"]]);
  });
});

describe("rule referencing a column that no longer exists", () => {
  const headers = ["a", "b"];
  const rows = [
    ["1", "2"],
    ["3", "4"],
  ];

  // Changed behavior (bug fix, decision #10, not a regression): a rule
  // whose column no longer exists is now IGNORED (isRuleActive returns
  // false), not applied as a rule that matches nothing. For an include
  // rule those are very different outcomes — "ignored" leaves every row
  // as-is, "matches nothing" used to drop every row in the file, which is
  // what this test's original "documented pre-existing behavior" comment
  // called out as intentional. It no longer is.
  it("an include rule on a missing column is ignored, not applied as 'matches nothing' (which used to drop every row)", () => {
    const result = applyFilters(headers, rows, "", [rule({ column: "ghost", operator: "equals", value: "1" })]);
    expect(result).toEqual(rows);
  });

  it("an exclude rule on a missing column never matches, so it drops nothing", () => {
    const result = applyFilters(headers, rows, "", [rule({ column: "ghost", operator: "equals", value: "1", mode: "exclude" })]);
    expect(result).toEqual(rows);
  });
});

describe("any-column rules", () => {
  it("column: null checks every cell in the row", () => {
    const headers = ["a", "b", "c"];
    const rows = [["x", "y", "z"], ["1", "2", "3"]];
    const result = applyFilters(headers, rows, "", [rule({ column: null, operator: "equals", value: "y" })]);
    expect(result).toEqual([["x", "y", "z"]]);
  });
});

describe("header names that collide with Object.prototype members", () => {
  it("a rule on a column literally named '__proto__' works correctly — filter.ts looks up columns via Array.indexOf on the headers array, not a plain-object map, so it is immune to the prototype-pollution trap that hits src/core/columns.ts (see columns.stress.test.ts)", () => {
    const headers = ["__proto__", "name"];
    const rows = [["evil", "Alice"], ["fine", "Bob"]];
    const result = applyFilters(headers, rows, "", [rule({ column: "__proto__", operator: "equals", value: "evil" })]);
    expect(result).toEqual([["evil", "Alice"]]);
  });

  it("a rule on a column named 'constructor' also works fine", () => {
    const headers = ["constructor", "name"];
    const rows = [["evil", "Alice"], ["fine", "Bob"]];
    const result = applyFilters(headers, rows, "", [rule({ column: "constructor", operator: "equals", value: "evil" })]);
    expect(result).toEqual([["evil", "Alice"]]);
  });
});

describe("combinations: several include + several exclude rules, disabled rules, quick search plus rules", () => {
  const headers = ["name", "age", "city"];
  const rows = [
    ["Alice", "30", "NYC"],
    ["Bob", "25", "LA"],
    ["Charlie", "40", "NYC"],
    ["Dave", "22", "SF"],
  ];

  it("two include rules AND two exclude rules all combine", () => {
    const rules: FilterRule[] = [
      rule({ column: "age", operator: "gte", value: "20", mode: "include" }),
      rule({ column: "city", operator: "contains", value: "", mode: "include" }), // no-op include
      rule({ column: "city", operator: "equals", value: "SF", mode: "exclude" }),
      rule({ column: "name", operator: "equals", value: "Bob", mode: "exclude" }),
    ];
    const result = applyFilters(headers, rows, "", rules);
    expect(result).toEqual([
      ["Alice", "30", "NYC"],
      ["Charlie", "40", "NYC"],
    ]);
  });

  it("a disabled rule (even an exclude-everything rule) has zero effect", () => {
    const rules: FilterRule[] = [rule({ column: "city", operator: "contains", value: "", mode: "exclude", enabled: false })];
    expect(applyFilters(headers, rows, "", rules)).toEqual(rows);
  });

  it("quick search narrows first, then rules narrow further (both must pass)", () => {
    const rules: FilterRule[] = [rule({ column: "age", operator: "gt", value: "23" })];
    const result = applyFilters(headers, rows, "nyc", rules);
    expect(result).toEqual([
      ["Alice", "30", "NYC"],
      ["Charlie", "40", "NYC"],
    ]);
  });
});

describe("property: applyFilters never throws regardless of rule shape", () => {
  it("random headers/rows/rules combinations, including regex garbage and out-of-range columns, never throw", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.array(fc.string({ maxLength: 8 }), { minLength: 1, maxLength: 4 }), { minLength: 0, maxLength: 20 }),
        fc.array(
          fc.record({
            id: fc.string(),
            column: fc.option(fc.string({ maxLength: 5 }), { nil: null }),
            operator: fc.constantFrom("contains", "equals", "startsWith", "endsWith", "regex", "isEmpty", "gt", "lt", "gte", "lte"),
            value: fc.string({ maxLength: 10 }),
            mode: fc.constantFrom("include", "exclude"),
            caseSensitive: fc.boolean(),
            enabled: fc.boolean(),
          }),
          { maxLength: 5 },
        ),
        (headers, rows, rules) => {
          expect(() => applyFilters(headers, rows, "", rules as FilterRule[])).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });
});
