import { describe, expect, it } from "vitest";
import { distinctValues } from "../core/distinct";

const valuesOf = (rows: string[][], col = 0, caps?: Parameters<typeof distinctValues>[2]): string[] =>
  distinctValues(rows, col, caps).values.map((v) => v.value);

describe("distinctValues: counts", () => {
  it("counts every row for each distinct value of the column", () => {
    const rows = [["a", "x"], ["b", "x"], ["a", "y"], ["a", "x"]];
    expect(distinctValues(rows, 0)).toEqual({
      values: [
        { value: "a", count: 3 },
        { value: "b", count: 1 },
      ],
      truncated: false,
    });
    expect(distinctValues(rows, 1).values).toEqual([
      { value: "x", count: 3 },
      { value: "y", count: 1 },
    ]);
  });

  it("an empty row list gives an empty, untruncated result", () => {
    expect(distinctValues([], 0)).toEqual({ values: [], truncated: false });
  });

  it("values are exact: case and surrounding whitespace make distinct entries", () => {
    expect(valuesOf([["a"], ["A"], [" a"], ["a "], ["a"]])).toHaveLength(4);
    expect(distinctValues([["a"], ["A"], ["a"]], 0).values.find((v) => v.value === "a")?.count).toBe(2);
  });

  it("a ragged row's missing cell counts as the blank value", () => {
    const rows = [["a", "x"], ["b"], [], ["c", ""]];
    expect(distinctValues(rows, 1).values).toEqual([
      { value: "", count: 3 },
      { value: "x", count: 1 },
    ]);
  });

  it("is safe for Object.prototype-ish values", () => {
    const rows = [["__proto__"], ["constructor"], ["__proto__"], ["toString"], ["hasOwnProperty"], ["constructor"], ["__proto__"]];
    const out = distinctValues(rows, 0);
    expect(out.truncated).toBe(false);
    expect(new Map(out.values.map((v) => [v.value, v.count]))).toEqual(
      new Map([
        ["__proto__", 3],
        ["constructor", 2],
        ["toString", 1],
        ["hasOwnProperty", 1],
      ]),
    );
  });
});

describe("distinctValues: order", () => {
  it("blank first, then numbers ascending, then text", () => {
    const rows = [["pear"], ["10"], [""], ["2"], ["apple"], ["-5"], ["1.5"], ["Banana"]];
    expect(valuesOf(rows)).toEqual(["", "-5", "1.5", "2", "10", "apple", "Banana", "pear"]);
  });

  it("numbers compare by value, not text ('9' < '10'); '1e1' parses as a number", () => {
    expect(valuesOf([["10"], ["9"], ["1e1"], ["100"]])).toEqual(["9", "10", "1e1", "100"]);
  });

  it("ties on number break by raw string, so the order is deterministic regardless of row order", () => {
    const a = valuesOf([["1e1"], ["10"], ["10.0"]]);
    const b = valuesOf([["10.0"], ["10"], ["1e1"]]);
    expect(a).toEqual(b);
    expect(a).toEqual(["10", "10.0", "1e1"]);
  });

  it("text uses a numeric-aware, case-insensitive collation ('item2' before 'item10')", () => {
    expect(valuesOf([["item10"], ["item2"], ["Item1"]])).toEqual(["Item1", "item2", "item10"]);
  });

  it("collation ties ('a' vs 'A') break by raw string, deterministically", () => {
    const a = valuesOf([["a"], ["A"]]);
    const b = valuesOf([["A"], ["a"]]);
    expect(a).toEqual(b);
    expect(a).toEqual(["A", "a"]);
  });

  it("whitespace-only values are text, not blank", () => {
    expect(valuesOf([[" "], [""], ["b"]])).toEqual(["", " ", "b"]);
  });
});

describe("distinctValues: caps", () => {
  it("stops adding new values at the distinct cap, flags truncated, and keeps counts exact", () => {
    const rows: string[][] = [];
    for (let i = 0; i < 20; i++) rows.push([`v${i % 10}`]);
    const out = distinctValues(rows, 0, { maxDistinct: 5 });
    expect(out.truncated).toBe(true);
    expect(out.values).toEqual([0, 1, 2, 3, 4].map((i) => ({ value: `v${i}`, count: 2 })));
  });

  it("exactly at the cap is not truncated", () => {
    const rows = [["a"], ["b"], ["c"], ["a"]];
    expect(distinctValues(rows, 0, { maxDistinct: 3 })).toEqual({
      values: [
        { value: "a", count: 2 },
        { value: "b", count: 1 },
        { value: "c", count: 1 },
      ],
      truncated: false,
    });
  });

  it("stops at the total-characters cap too, and later rows still count toward collected values", () => {
    const rows = [["aaaa"], ["bbbb"], ["cccc"], ["aaaa"], ["dd"], ["bbbb"]];
    const out = distinctValues(rows, 0, { maxChars: 9 });
    expect(out.truncated).toBe(true);
    expect(out.values).toEqual([
      { value: "aaaa", count: 2 },
      { value: "bbbb", count: 2 },
    ]);
  });

  it("a total exactly at the character cap is not truncated", () => {
    expect(distinctValues([["aaaa"], ["bbbb"]], 0, { maxChars: 8 }).truncated).toBe(false);
  });

  it("applies the documented defaults: 10,000 distinct values", () => {
    const rows = Array.from({ length: 10_050 }, (_, i) => [`v${i}`]);
    rows.push(["v0"], ["v0"]);
    const out = distinctValues(rows, 0);
    expect(out.truncated).toBe(true);
    expect(out.values).toHaveLength(10_000);
    expect(out.values.find((v) => v.value === "v0")?.count).toBe(3);
    expect(out.values.find((v) => v.value === "v10040")).toBeUndefined();
  });

  it("applies the documented defaults: 2,000,000 total characters", () => {
    const big = "x".repeat(1_000_000);
    const rows = [[`${big}1`], [`${big}2`], ["tiny"], [`${big}1`]];
    const out = distinctValues(rows, 0);
    expect(out.truncated).toBe(true);
    expect(out.values.map((v) => v.count)).toEqual([2]);
    expect(out.values[0].value).toBe(`${big}1`);
  });
});
