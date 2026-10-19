import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../core/csvParse";
import { ProgressiveParse, parseProgressive } from "../core/progressiveParse";
import { spansFromTable, splitRecordsToTable } from "../core/recordSpans";

const PIECES = ["\u00a0", "\u3000", "\u2028", "a", "b", "1", "22", ",", ";", "|", "\t", '"', '""', '"', " ", "\n", "\r", "\r\n", "\n\r", "é", "😀", "﻿", "\u0000", "||", ";;", "x y", "a\nb", '"q,r"', '"m\nn"', "5\" "];
const textArb = fc.array(fc.constantFrom(...PIECES), { maxLength: 40 }).map((p) => p.join(""));
// Many short lines, so that several slices are cut and quotes can open and close across them.
const LINE_PIECES = ["a", "b", "1", ",", ";", '"', '""', " ", "é", "x y", '"q,r"', '"m\nn"', "", "||"];
const linesArb = fc
  .tuple(fc.array(fc.array(fc.constantFrom(...LINE_PIECES), { maxLength: 6 }).map((p) => p.join("")), { maxLength: 30 }), fc.constantFrom("\n", "\r\n", "\r", "\n\r"))
  .map(([lines, eol]) => lines.join(eol));
const optionsArb = fc.record({
  delimiter: fc.constantFrom("", ",", ";", "|", "\t", "||", ";;", '"', "\n", "\r", "ab"),
  quotes: fc.boolean(),
  firstRowIsHeader: fc.boolean(),
});

function expectSame(text: string, opts: { delimiter: string; quotes: boolean; firstRowIsHeader: boolean }, slice: number): boolean {
  const whole = parseCsv(text, opts);
  const { result, spans, fellBack } = parseProgressive(text, opts, slice);
  expect(result.headers).toEqual(whole.headers);
  expect(result.rows).toEqual(whole.rows);
  expect(result.delimiter).toBe(whole.delimiter);
  expect(result.quoting).toBe(whole.quoting);
  expect(result.quoteProblems).toEqual(whole.quoteProblems);
  expect(spansFromTable(spans)).toEqual(spansFromTable(splitRecordsToTable(text, { delimiter: whole.delimiter, quotes: whole.quoting })));
  return fellBack;
}

describe("progressive parse equals parseCsv", () => {
  it("on arbitrary nasty texts and slice sizes from one record up (property)", () => {
    let fallbacks = 0;
    let runs = 0;
    fc.assert(
      fc.property(textArb, optionsArb, fc.integer({ min: 1, max: 8 }), (text, opts, slice) => {
        runs++;
        if (expectSame(text, opts, slice)) fallbacks++;
      }),
      { numRuns: 12000 },
    );
    // Falling back is always correct, but the slices must do the work on most inputs or this proves little.
    expect(fallbacks / runs).toBeLessThan(0.25);
  });

  it("on many short lines cut into several slices, with every line ending (property)", () => {
    let fallbacks = 0;
    let runs = 0;
    fc.assert(
      fc.property(linesArb, optionsArb, fc.integer({ min: 1, max: 12 }), (text, opts, slice) => {
        runs++;
        if (expectSame(text, opts, slice)) fallbacks++;
      }),
      { numRuns: 8000 },
    );
    expect(fallbacks / runs).toBeLessThan(0.25);
  });

  it("with the default slice size, on a file of several slices with ragged rows, quotes and a BOM", () => {
    const lines = ["﻿id,name,note"];
    for (let i = 0; i < 6000; i++) lines.push(i % 7 === 0 ? `${i},"Smith, ${i}","multi\nline"` : i % 1500 === 1499 ? `${i},x,y,z,w` : `${i},n${i}`);
    const text = lines.join("\r\n") + "\r\n";
    const opts = { delimiter: "", quotes: true, firstRowIsHeader: true };
    expect(expectSame(text, opts, 2048)).toBe(false);
  });

  it("reports the rows a malformed quote is found on, as parseCsv does", () => {
    const text = ["a,b", "1,2", "", '3,"x"y,z', "4,5", "6,7"].join("\n");
    for (let slice = 1; slice <= 6; slice++) expectSame(text, { delimiter: "", quotes: true, firstRowIsHeader: true }, slice);
    const bad = parseProgressive(text, { firstRowIsHeader: true }, 2).result.quoteProblems;
    expect(bad.length).toBeGreaterThan(0);
  });

  it("the headers grow when a later row is wider, and earlier rows are padded at the end", () => {
    const text = "a,b\n1,2\n3,4\n5,6,7,8\n";
    const parse = new ProgressiveParse(text, {}, 2);
    parse.step();
    expect(parse.headers()).toEqual(["a", "b"]);
    expect(parse.done).toBe(false);
    parse.runToEnd();
    expect(parse.headers()).toEqual(["a", "b", "column_3", "column_4"]);
    expect(parse.result().rows).toEqual([["1", "2", "", ""], ["3", "4", "", ""], ["5", "6", "7", "8"]]);
  });

  it("falls back to the whole-text parse for a quote delimiter with quoting off, and says it rebuilt nothing", () => {
    const text = 'a"b"c\n1"2"3\n';
    const parse = new ProgressiveParse(text, { delimiter: '"', quotes: false }, 1);
    expect(parse.fellBack).toBe(true);
    expect(parse.done).toBe(true);
    expect(parse.rebuilt).toBe(false);
    expect(parse.result()).toEqual(parseCsv(text, { delimiter: '"', quotes: false }));
  });

  it("an empty text has no headers, rows or spans", () => {
    const { result, spans } = parseProgressive("", {}, 4);
    expect(result).toEqual(parseCsv(""));
    expect(spans.length).toBe(0);
  });
});
