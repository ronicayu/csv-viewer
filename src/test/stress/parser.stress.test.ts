// Adversarial stress tests for the CSV parser (src/core/csvParse.ts), the
// column-visibility maps built on top of it (src/core/columns.ts), and the
// separator-resolution logic in the webview (resolveDelimiterOption in
// src/webview/main.ts, exercised here indirectly via parseCsv's `delimiter`
// option, which is what that function ultimately feeds).
//
// Convention (per task): a test that demonstrates a real bug is written as
// `test.fails(...)` asserting the CORRECT/expected behavior — since the code
// is buggy, that assertion currently fails, and `.fails` inverts that so the
// suite stays green while the bug stays documented in the comment above each
// one. A test asserting today's (correct) behavior is a plain `test`/`it`.
//
// All findings below were verified against the actual output of parseCsv /
// columns.ts in this repo before being written down (see the final report
// for the full bug list with severities).

import { describe, expect, it, test } from "vitest";
import { parseCsv } from "../../core/csvParse";
import { defaultVisibility, detailFieldsFor, reconcileVisibility, visibleColumns } from "../../core/columns";

describe("empty / degenerate input", () => {
  it("empty file", () => {
    const r = parseCsv("");
    expect(r.headers).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  it("empty file with firstRowIsHeader: false", () => {
    const r = parseCsv("", { firstRowIsHeader: false });
    expect(r.headers).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  it("whitespace-only file: each whitespace-only line is a real record, not blank", () => {
    // skipEmptyLines only drops lines with zero characters at all; a line
    // of spaces has characters, so it is kept — first as header, second as
    // a one-cell data row.
    const r = parseCsv("   \n   \n");
    expect(r.headers).toEqual(["   "]);
    expect(r.rows).toEqual([["   "]]);
  });

  it("header-only file, no trailing newline", () => {
    const r = parseCsv("a,b,c");
    expect(r.headers).toEqual(["a", "b", "c"]);
    expect(r.rows).toEqual([]);
  });

  it("header-only file, with trailing newline", () => {
    const r = parseCsv("a,b,c\n");
    expect(r.headers).toEqual(["a", "b", "c"]);
    expect(r.rows).toEqual([]);
  });

  it("single cell, no newline: becomes the header with zero data rows (firstRowIsHeader default true)", () => {
    const r = parseCsv("hello");
    expect(r.headers).toEqual(["hello"]);
    expect(r.rows).toEqual([]);
  });

  it("single cell, no newline, firstRowIsHeader: false: becomes one data row", () => {
    const r = parseCsv("hello", { firstRowIsHeader: false });
    expect(r.headers).toEqual(["column_1"]);
    expect(r.rows).toEqual([["hello"]]);
  });
});

describe("encoding: BOM, wide chars, emoji, RTL, control chars", () => {
  it("strips a BOM and still respects a quoted first header", () => {
    const r = parseCsv('﻿"name",age\nAlice,30');
    expect(r.headers).toEqual(["name", "age"]);
    expect(r.rows).toEqual([["Alice", "30"]]);
  });

  it("preserves UTF-16 surrogate pairs and emoji (including ZWJ sequences) verbatim in fields and headers", () => {
    const r = parseCsv('name,👨‍👩‍👧‍👦\n"😀 test","🚀🚀"');
    expect(r.headers).toEqual(["name", "👨‍👩‍👧‍👦"]);
    expect(r.rows).toEqual([["😀 test", "🚀🚀"]]);
  });

  it("preserves CJK text", () => {
    const r = parseCsv("名前,年齢\n太郎,30");
    expect(r.headers).toEqual(["名前", "年齢"]);
    expect(r.rows).toEqual([["太郎", "30"]]);
  });

  it("preserves RTL text", () => {
    const r = parseCsv("name,note\nAli,שלום עולם");
    expect(r.rows).toEqual([["Ali", "שלום עולם"]]);
  });

  it("preserves NUL and other control characters inside cells", () => {
    const r = parseCsv("a,b\n\u0000x,\u0001y");
    expect(r.rows).toEqual([["\u0000x", "\u0001y"]]);
  });
});

describe("line endings", () => {
  // FIXED (decision, not a bug): csvParse.ts now normalizes every line
  // ending style (CRLF, lone CR) to LF before Papa ever sees the text, so
  // mixed line endings never merge rows (see below). That normalization
  // necessarily also applies inside quoted fields — there's no way to tell
  // "a CRLF that's part of quoted content" from "a CRLF that separates
  // rows" without a full parse pass, and mixed line endings merging rows
  // is by far the worse failure mode. So an embedded CRLF (or lone CR) in
  // a quoted field is now normalized to LF too. This test's expectation
  // was updated to match that documented, deliberate tradeoff — it
  // previously asserted the CRLF survived intact, which the fix above no
  // longer preserves.
  it("a quoted field containing an embedded CRLF is preserved, normalized to LF", () => {
    const r = parseCsv('a,b\n"x\r\ny",2');
    expect(r.rows).toEqual([["x\ny", "2"]]);
  });

  // FIXED: csvParse.ts normalizes \r\n and lone \r to \n before parsing, so
  // a file mixing CRLF/LF/CR line endings parses one row per physical line
  // instead of merging rows and leaking newline characters into cells.
  it("CRLF header followed by an LF-terminated data line still starts a new row", () => {
    const r = parseCsv("a,b\r\n1,2\n3,4");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("LF header followed by a lone-CR-terminated data line still starts a new row", () => {
    const r = parseCsv("a,b\n1,2\r3,4");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("a file mixing all three line-ending styles parses one row per physical line", () => {
    const r = parseCsv("a,b\r\n1,2\n3,4\r5,6");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("mixed line endings no longer corrupt rows with firstRowIsHeader: false", () => {
    const r = parseCsv("1,2\r\n3,4\n5,6\r7,8", { firstRowIsHeader: false });
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
      ["7", "8"],
    ]);
  });

  it("a lone-CR-only file (no mixing) parses correctly", () => {
    // Documented, non-buggy baseline: the bug above is specifically about
    // *mixing* styles, not CR-only files, which already work (and are
    // already covered in csvParse.test.ts).
    const r = parseCsv("a,b\r1,2\r3,4");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("malformed quoting", () => {
  it("an unclosed quote at EOF consumes the rest of the line as literal text without crashing", () => {
    // Documented behavior: no closing quote is ever found, so everything
    // through EOF becomes the field's content (including the delimiter
    // that would otherwise have ended it); the short row is then padded.
    const r = parseCsv('a,b\n"unterminated,2');
    expect(r.rows).toEqual([["unterminated,2", ""]]);
  });

  it("a quote mid-field (not as the first character) is literal text, not a quote-open", () => {
    const r = parseCsv('a,b\n1,he said "hi"');
    expect(r.rows).toEqual([["1", 'he said "hi"']]);
  });

  it('a doubled quote ("") inside an unquoted field is literal text, not an escape', () => {
    const r = parseCsv('a,b\n1,ab""cd');
    expect(r.rows).toEqual([["1", 'ab""cd']]);
  });

  it("whitespace before the opening quote means it never opens a quoted field", () => {
    // Matches the documented rule in csvParse.ts's header comment: `"` only
    // opens a quoted field as the literal first character of the field.
    const r = parseCsv('a,b\n1, "b"');
    expect(r.rows).toEqual([["1", ' "b"']]);
  });

  // FIXED (decision, not by teaching Papa a smarter quote state machine): a
  // quote that opens right after a delimiter, closes, and is followed by
  // more text before the next delimiter (e.g. `h,"b"c,d`) still makes Papa
  // swallow the rest of the row into one field WHEN QUOTING IS ON — that's
  // inherent to quote-aware CSV parsing and the decision was explicitly to
  // keep Papa rather than hand-roll different quote handling. What's fixed
  // instead: `quoteProblems` flags the affected row, and re-parsing with
  // `quotes: false` (the "Treat quotes as plain text" workaround the
  // webview offers once quoteProblems is non-empty) recovers the correct
  // field/row structure, with `"` kept as literal text since quoting is
  // off. This test's original "expected" assertion — that quoting-ON
  // parsing itself would produce ["h","bc","d"] — conflicted with that
  // decision, so it was rewritten to check the actual fix (quoteProblems +
  // the quotes:false escape hatch) instead.
  it('quote right after a delimiter, with text after the closing quote: unchanged with quoting on (documented), flagged via quoteProblems, and recovered with quotes:false', () => {
    const withQuotes = parseCsv('h,"b"c,d', { firstRowIsHeader: false });
    expect(withQuotes.rows).toEqual([["h", 'b"c,d']]);
    expect(withQuotes.quoteProblems).toEqual([{ row: 1 }]);

    const withoutQuotes = parseCsv('h,"b"c,d', { firstRowIsHeader: false, quotes: false });
    expect(withoutQuotes.rows).toEqual([["h", '"b"c', "d"]]);
    expect(withoutQuotes.quoteProblems).toEqual([]);
  });

  it("the same malformed-quote pattern: unchanged with quoting on (still swallows subsequent lines, documented), flagged via quoteProblems, and recovered with quotes:false", () => {
    const withQuotes = parseCsv('"b"c,d\ne,f', { firstRowIsHeader: false });
    expect(withQuotes.rows).toEqual([['b"c,d\ne,f']]);
    expect(withQuotes.quoteProblems).toEqual([{ row: 1 }]);

    const withoutQuotes = parseCsv('"b"c,d\ne,f', { firstRowIsHeader: false, quotes: false });
    expect(withoutQuotes.rows).toEqual([
      ['"b"c', "d"],
      ["e", "f"],
    ]);
    expect(withoutQuotes.quoteProblems).toEqual([]);
  });
});

describe('header names colliding with JS object internals ("__proto__" etc.)', () => {
  it('parseCsv itself handles "__proto__", "constructor", "toString", "hasOwnProperty" as ordinary header text', () => {
    expect(parseCsv("__proto__,b\n1,2").headers).toEqual(["__proto__", "b"]);
    expect(parseCsv("constructor,b\n1,2").headers).toEqual(["constructor", "b"]);
    expect(parseCsv("toString,b\n1,2").headers).toEqual(["toString", "b"]);
    expect(parseCsv("hasOwnProperty,b\n1,2").headers).toEqual(["hasOwnProperty", "b"]);
  });

  it('"constructor", "toString", and "hasOwnProperty" round-trip correctly through the columnVisibility map', () => {
    // These are inherited, ordinary *data* properties/methods (not
    // accessors like __proto__), so a plain assignment on the map object
    // shadows them with a real own property, and
    // Object.prototype.hasOwnProperty.call(...) (used defensively in
    // reconcileVisibility) still reports them correctly.
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      const headers = [name, "b"];
      const shown = defaultVisibility(headers, 1); // name -> true, b -> false
      expect(Object.prototype.hasOwnProperty.call(shown, name)).toBe(true);
      expect(shown[name]).toBe(true);
      expect(visibleColumns(headers, shown)).toEqual([name]);
      expect(detailFieldsFor(headers, shown)).toEqual(["b"]);

      const hidden = defaultVisibility(headers, 0); // both detail-only
      expect(hidden[name]).toBe(false);
      expect(visibleColumns(headers, hidden)).toEqual([]);

      const reconciled = reconcileVisibility(headers, hidden, 0);
      expect(reconciled[name]).toBe(false);
    }
  });

  // FIXED: defaultVisibility/reconcileVisibility (src/core/columns.ts) now
  // write every entry via Object.defineProperty and read only via
  // Object.prototype.hasOwnProperty.call + the getVisibility helper, so a
  // header literally named "__proto__" no longer hits the accessor's
  // silent-no-op-on-write trap.
  it('a column named "__proto__" can be hidden (marked detail-only) like any other column', () => {
    const headers = ["__proto__", "b"];
    const hidden = defaultVisibility(headers, 0); // both columns should be detail-only
    expect(Object.prototype.hasOwnProperty.call(hidden, "__proto__")).toBe(true);
    expect(hidden["__proto__"]).toBe(false);
    expect(visibleColumns(headers, hidden)).toEqual([]);
    expect(detailFieldsFor(headers, hidden)).toEqual(["__proto__", "b"]);
  });

  // NOTE: the original version of this test built `previous` as
  // `{ __proto__: false } as unknown as Record<string, boolean>`. That's
  // object-LITERAL `__proto__: false` syntax, which the ECMAScript grammar
  // special-cases identically to the bracket-assignment trap this bug is
  // about (it tries to set the object's prototype, `false` isn't an object
  // so the attempt is silently ignored, and — either way — no *own*
  // "__proto__" property is ever created). So that fixture could never
  // carry a real own "__proto__" property regardless of whether
  // reconcileVisibility itself is fixed; it was testing the test's own
  // setup, not the bug. The realistic source per the task's own framing
  // ("persisted state is JSON in VS Code workspaceState") is JSON.parse,
  // which — unlike either literal form — does create a genuine own
  // "__proto__" property (per the JSON spec's use of CreateDataProperty).
  // Rebuilt around that so the test actually exercises the fix.
  it('reconcileVisibility can persist a "false" (hidden) setting for a "__proto__" column across reloads', () => {
    const headers = ["__proto__"];
    const previous = JSON.parse('{"__proto__": false}') as Record<string, boolean>;
    expect(Object.prototype.hasOwnProperty.call(previous, "__proto__")).toBe(true); // sanity: JSON.parse (unlike a literal/bracket write) really does create an own property
    const reconciled = reconcileVisibility(headers, previous, 0);
    expect(Object.prototype.hasOwnProperty.call(reconciled, "__proto__")).toBe(true);
    expect(visibleColumns(headers, reconciled)).toEqual([]);
  });
});

describe("duplicate headers", () => {
  // FIXED: dedupeNames (src/core/csvParse.ts) now checks every generated
  // `_N` candidate against every literal name in the file (not just names
  // already assigned so far), so a duplicate never claims a suffix that a
  // later literal header will also want. "a,a,a_2": the literal "a_2"
  // (index 2) keeps its name; the duplicate "a" (index 1) skips "a_2"
  // (reserved for that literal) and becomes "a_3" instead.
  it('"a,a,a_2" produces three distinct header names, not a collision', () => {
    const r = parseCsv("a,a,a_2\n1,2,3");
    expect(new Set(r.headers).size).toBe(3);
    expect(r.headers).toEqual(["a", "a_3", "a_2"]);
  });

  it('"a,a,a,a_2" (a longer collision chain) also produces four distinct header names', () => {
    const r = parseCsv("a,a,a,a_2\n1,2,3,4");
    expect(new Set(r.headers).size).toBe(4);
    expect(r.headers).toEqual(["a", "a_3", "a_4", "a_2"]);
  });

  it("an empty header interleaved with a literal `column_N` header happens not to collide here", () => {
    // Documented, non-buggy in this specific arrangement: the empty cell at
    // index 1 is named "column_2" (positional), and the *third* cell is
    // already literally "column_2" — but dedupeNames processes left to
    // right and only renames the *second* occurrence of an exact string, so
    // here it renames the real "column_2" (not the synthesized one) to
    // "column_2_2". No collision — but see the __proto__/a_2 cases above
    // for arrangements where the same mechanism does collide.
    const r = parseCsv("a,,column_2\n1,2,3");
    expect(r.headers).toEqual(["a", "column_2", "column_2_2"]);
    expect(new Set(r.headers).size).toBe(3);
  });
});

describe("ragged rows", () => {
  it("a row much shorter than the header is padded with empty strings", () => {
    const r = parseCsv("a,b,c,d,e\n1,2");
    expect(r.rows).toEqual([["1", "2", "", "", ""]]);
  });

  it("a row much longer than the header gets column_N headers for the extra cells, up to 10k cells", () => {
    const header = "a,b";
    const cellCount = 10000;
    const row = Array.from({ length: cellCount }, (_, i) => String(i)).join(",");
    const r = parseCsv(`${header}\n${row}`);
    expect(r.headers.length).toBe(cellCount);
    expect(r.headers.slice(0, 4)).toEqual(["a", "b", "column_3", "column_4"]);
    expect(r.rows[0].length).toBe(cellCount);
    expect(r.rows[0][0]).toBe("0");
    expect(r.rows[0][cellCount - 1]).toBe(String(cellCount - 1));
  });
});

describe("delimiter auto-detection", () => {
  it("a single-column file whose values contain commas inside quotes is not split on those commas", () => {
    const r = parseCsv('a\n"1,2,3"\n"4,5,6"\n"7,8,9"');
    expect(r.delimiter).toBe(",");
    expect(r.headers).toEqual(["a"]);
    expect(r.rows).toEqual([["1,2,3"], ["4,5,6"], ["7,8,9"]]);
  });

  it("a semicolon file with many commas inside quoted text detects semicolon correctly", () => {
    const r = parseCsv('name;note\n"a, b, c, d";"x"\n"e, f, g, h";"y"');
    expect(r.delimiter).toBe(";");
    expect(r.rows).toEqual([
      ["a, b, c, d", "x"],
      ["e, f, g, h", "y"],
    ]);
  });

  it("a tab file whose values also contain spaces still detects tab", () => {
    const r = parseCsv("col a\tcol b\n1 1\t2 2\n3 3\t4 4");
    expect(r.delimiter).toBe("\t");
    expect(r.headers).toEqual(["col a", "col b"]);
    expect(r.rows).toEqual([
      ["1 1", "2 2"],
      ["3 3", "4 4"],
    ]);
  });

  // BUG (medium): Papa's delimiter guess counts raw character frequency
  // across the sample rows. When `|` appears in the data itself (not as a
  // delimiter) more often per line than the real delimiter `,` does, Papa
  // picks `|` as "the" delimiter — splitting literal data apart — even
  // though a human looking at this file would immediately read it as a
  // 2-column, comma-delimited file with pipes inside the values.
  test.fails("a literal `|` appearing in every row of an otherwise comma-delimited file does not hijack delimiter detection", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `${i}|x,${i}|y`);
    const r = parseCsv(lines.join("\n"), { firstRowIsHeader: false });
    expect(r.delimiter).toBe(",");
    expect(r.headers.length).toBe(2);
    expect(r.rows[0]).toEqual(["0|x", "0|y"]);
  });

  // BUG (low/medium, known Papa limitation worth documenting): delimiter
  // guessing only samples a prefix of the file. If the first ~10 lines
  // don't exhibit the real delimiter at all (e.g. single bare tokens with
  // no delimiter, followed by clearly semicolon-delimited data further
  // down), Papa never sees evidence for ";" and falls back to its default
  // of ",", collapsing the whole file into one column.
  test.fails("delimiter detection still finds the real delimiter when it only shows up after ~10 unrepresentative rows", () => {
    const preamble = Array.from({ length: 9 }, (_, i) => `row${i}`).join("\n");
    const body = "a;b;c\n1;2;3\n4;5;6\n7;8;9\n10;11;12";
    const r = parseCsv(`${preamble}\n${body}`);
    expect(r.delimiter).toBe(";");
  });

  it("multi-character custom delimiter `||` is honored exactly", () => {
    const r = parseCsv("a||b||c\n1||2||3", { delimiter: "||" });
    expect(r.delimiter).toBe("||");
    expect(r.headers).toEqual(["a", "b", "c"]);
    expect(r.rows).toEqual([["1", "2", "3"]]);
  });

  it.each([
    { name: "regex-special .", delimiter: "." },
    { name: "regex-special *", delimiter: "*" },
    { name: "backslash", delimiter: "\\" },
    { name: "single space", delimiter: " " },
    { name: "multi-byte §", delimiter: "§" },
    { name: "multi-byte arrow →", delimiter: "→" },
  ])("custom delimiter ($name) is used literally, not as a regex", ({ delimiter }) => {
    const r = parseCsv(`a${delimiter}b\n1${delimiter}2`, { delimiter });
    expect(r.delimiter).toBe(delimiter);
    expect(r.headers).toEqual(["a", "b"]);
    expect(r.rows).toEqual([["1", "2"]]);
  });

  // BUG (medium): the quote character `"` is a valid 1-character value for
  // the "Custom…" separator input per the spec (any 1–5 char string), but
  // parseCsv's quoteChar is hard-coded to `"`. Requesting `"` as the
  // delimiter isn't honored *and isn't rejected either* — it's silently
  // dropped, and the parser falls all the way back to comma auto-detection
  // against data that has no commas at all, producing one garbage column
  // instead of either honoring the delimiter or failing loudly.
  // FIXED, but only when quoting is off: Papa Parse hardcodes `"` as an
  // always-bad delimiter (Papa.BAD_DELIMITERS forces a requested delimiter
  // of `"` back to `,`), unconditionally, regardless of quoteChar — so `"`
  // can never be handed to Papa's own `delimiter` option directly. The
  // decision was: with quoting ON, `"` as a delimiter is rejected one
  // layer up, in the webview, before parseCsv is ever called with this
  // combination (see the "Separator" custom-input handling in
  // src/webview/main.ts) — so parseCsv's behavior for that combination is
  // unchanged and now moot, not "fixed". With quoting OFF, `"` IS a valid
  // delimiter (there's no quoting to protect it from), and parseCsv works
  // around Papa's hardcoded restriction (see QUOTE_DELIMITER_PLACEHOLDER).
  // This test's original "expected" assertion (that quoting-ON parsing
  // itself would honor `"` as delimiter) conflicted with that decision, so
  // it was rewritten to cover both cases.
  it('using `"` as the custom delimiter: unchanged (falls back to auto-detected comma) with quoting on — moot, since the webview rejects it before calling parseCsv — and honored with quoting off', () => {
    const withQuotesOn = parseCsv('a"b\n1"2', { delimiter: '"' });
    expect(withQuotesOn.delimiter).toBe(",");
    expect(withQuotesOn.headers).toEqual(['a"b']);

    const withQuotesOff = parseCsv('a"b\n1"2', { delimiter: '"', quotes: false });
    expect(withQuotesOff.delimiter).toBe('"');
    expect(withQuotesOff.headers).toEqual(["a", "b"]);
    expect(withQuotesOff.rows).toEqual([["1", "2"]]);
  });
});

describe("firstRowIsHeader: false combined with adversarial input", () => {
  it("ragged rows still pad/extend correctly with no header row", () => {
    const r = parseCsv("1,2\n3,4,5,6", { firstRowIsHeader: false });
    expect(r.headers).toEqual(["column_1", "column_2", "column_3", "column_4"]);
    expect(r.rows).toEqual([
      ["1", "2", "", ""],
      ["3", "4", "5", "6"],
    ]);
  });

  it('a value that happens to equal "__proto__" is just ordinary cell data, not a header, so no bug here', () => {
    const r = parseCsv("h\n__proto__", { firstRowIsHeader: false });
    expect(r.rows).toEqual([["h"], ["__proto__"]]);
  });

  it("mixed line endings no longer corrupt rows when firstRowIsHeader is false (see the line-endings fix above)", () => {
    const r = parseCsv("1,2\r\n3,4\n5,6\r7,8", { firstRowIsHeader: false });
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
      ["7", "8"],
    ]);
  });

  test.fails("the pipe-hijacks-delimiter-detection bug reproduces with firstRowIsHeader: false too", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `${i}|x,${i}|y`);
    const r = parseCsv(lines.join("\n"), { firstRowIsHeader: false });
    expect(r.delimiter).toBe(",");
  });
});

describe("scale and performance (generous upper bounds; observed timings logged)", () => {
  function timed<T>(label: string, fn: () => T): T {
    const memBefore = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const result = fn();
    const ms = Date.now() - t0;
    const heapDeltaMb = (process.memoryUsage().heapUsed - memBefore) / 1024 / 1024;
    // Observed on this machine at authoring time: ~0.7s / ~135MB heap delta.
    // eslint-disable-next-line no-console
    console.log(`[perf] ${label}: ${ms}ms, heapUsed delta ${heapDeltaMb.toFixed(1)}MB`);
    return result;
  }

  it(
    "500k rows x 10 cols parses well within a generous bound",
    () => {
      const header = Array.from({ length: 10 }, (_, i) => `col${i}`).join(",");
      const lines = [header];
      for (let i = 0; i < 500000; i++) {
        lines.push(Array.from({ length: 10 }, (_, c) => `${i}-${c}`).join(","));
      }
      const text = lines.join("\n");
      const t0 = Date.now();
      const r = timed("500k rows x 10 cols", () => parseCsv(text));
      expect(Date.now() - t0).toBeLessThan(15000); // observed ~0.7s
      expect(r.rows.length).toBe(500000);
      expect(r.headers.length).toBe(10);
    },
    30000,
  );

  it(
    "1k columns x 1k rows parses well within a generous bound",
    () => {
      const header = Array.from({ length: 1000 }, (_, i) => `col${i}`).join(",");
      const lines = [header];
      for (let i = 0; i < 1000; i++) {
        lines.push(Array.from({ length: 1000 }, (_, c) => `${i}-${c}`).join(","));
      }
      const text = lines.join("\n");
      const t0 = Date.now();
      const r = timed("1k cols x 1k rows", () => parseCsv(text));
      expect(Date.now() - t0).toBeLessThan(10000); // observed ~40ms
      expect(r.rows.length).toBe(1000);
      expect(r.headers.length).toBe(1000);
    },
    20000,
  );

  it(
    "a single 5MB cell parses well within a generous bound",
    () => {
      const bigCell = "x".repeat(5 * 1024 * 1024);
      const text = `a,b\n1,"${bigCell}"`;
      const t0 = Date.now();
      const r = timed("single 5MB cell", () => parseCsv(text));
      expect(Date.now() - t0).toBeLessThan(5000); // observed ~5ms
      expect(r.rows[0][1].length).toBe(5 * 1024 * 1024);
    },
    15000,
  );

  it(
    "50k rows where every field is quoted with embedded newlines parses well within a generous bound",
    () => {
      const lines = ["a,b,c"];
      for (let i = 0; i < 50000; i++) {
        lines.push(`"line${i}\nmore${i}","val${i}\nx","z${i}"`);
      }
      const text = lines.join("\n");
      const t0 = Date.now();
      const r = timed("50k rows, all quoted w/ embedded newlines", () => parseCsv(text));
      expect(Date.now() - t0).toBeLessThan(10000); // observed ~50ms
      expect(r.rows.length).toBe(50000);
      expect(r.rows[0]).toEqual(["line0\nmore0", "val0\nx", "z0"]);
    },
    20000,
  );
});
