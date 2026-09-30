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
  it("a quoted field containing an embedded CRLF is preserved intact", () => {
    const r = parseCsv('a,b\n"x\r\ny",2');
    expect(r.rows).toEqual([["x\r\ny", "2"]]);
  });

  // BUG (medium/high): Papa Parse sniffs a single newline style for the
  // whole file (from an early sample) and then treats any *other*
  // line-ending character as literal text rather than a row separator. A
  // file that mixes CRLF, LF, and lone CR — which real-world CSVs exported
  // by different tools/OSes routinely do — silently merges rows and leaks
  // newline characters into cell values instead of parsing each physical
  // line as its own row.
  test.fails("CRLF header followed by an LF-terminated data line still starts a new row", () => {
    // Expected: two independent two-cell rows, since one line uses CRLF and
    // the other LF — both are valid line terminators per the spec's own
    // claim of CRLF/LF/CR support.
    const r = parseCsv("a,b\r\n1,2\n3,4");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test.fails("LF header followed by a lone-CR-terminated data line still starts a new row", () => {
    const r = parseCsv("a,b\n1,2\r3,4");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test.fails("a file mixing all three line-ending styles parses one row per physical line", () => {
    const r = parseCsv("a,b\r\n1,2\n3,4\r5,6");
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  test.fails("mixed line endings bug reproduces with firstRowIsHeader: false", () => {
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

  // BUG (high): a quote that opens right after a delimiter, closes, and is
  // then followed directly by more text before the next delimiter (e.g.
  // `a,"b"c,d`) does not resume normal unquoted parsing after the close.
  // Instead the parser appears to re-enter a quote-like state and swallows
  // *everything* remaining in the input — including further delimiters and
  // even further newlines — into a single field, silently destroying the
  // rest of the row/file's structure.
  test.fails('quote right after a delimiter, with text after the closing quote, does not swallow the rest of the row', () => {
    // Expected (standard CSV "lenient" behavior, and what a human editing
    // `h,"b"c,d` would expect): the trailing `c` after the closing quote is
    // appended to that field, but the delimiter immediately after it is
    // still honored, giving three fields: "h", "bc", "d".
    const r = parseCsv('h,"b"c,d', { firstRowIsHeader: false });
    expect(r.rows).toEqual([["h", "bc", "d"]]);
  });

  test.fails("the same malformed-quote pattern must not swallow subsequent lines either", () => {
    // Expected: two independent two-cell rows. Actual: the entire remainder
    // of the file — including the newline and the second line — ends up
    // inside a single field of a single row.
    const r = parseCsv('"b"c,d\ne,f', { firstRowIsHeader: false });
    expect(r.rows).toEqual([
      ["bc", "d"],
      ["e", "f"],
    ]);
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

  // BUG (high): "__proto__" is an *accessor* on Object.prototype whose
  // setter silently no-ops for a non-object value. defaultVisibility does
  // `map[h] = true/false` on a plain object literal, so
  // `map["__proto__"] = false` (or `= true`) never actually creates an own
  // "__proto__" property — it's swallowed. Reading `map["__proto__"]` back
  // then returns the object's actual prototype (Object.prototype), which is
  // never `=== false`, so a column literally named "__proto__" can never be
  // recorded as hidden and always renders as visible in the table,
  // regardless of what the user (or reconcileVisibility) tried to set.
  test.fails('a column named "__proto__" can be hidden (marked detail-only) like any other column', () => {
    const headers = ["__proto__", "b"];
    const hidden = defaultVisibility(headers, 0); // both columns should be detail-only
    expect(Object.prototype.hasOwnProperty.call(hidden, "__proto__")).toBe(true);
    expect(hidden["__proto__"]).toBe(false);
    expect(visibleColumns(headers, hidden)).toEqual([]);
    expect(detailFieldsFor(headers, hidden)).toEqual(["__proto__", "b"]);
  });

  test.fails('reconcileVisibility can persist a "false" (hidden) setting for a "__proto__" column across reloads', () => {
    const headers = ["__proto__"];
    const previous = { __proto__: false } as unknown as Record<string, boolean>; // what saved state would look like if it had worked
    const reconciled = reconcileVisibility(headers, previous, 0);
    expect(Object.prototype.hasOwnProperty.call(reconciled, "__proto__")).toBe(true);
    expect(visibleColumns(headers, reconciled)).toEqual([]);
  });
});

describe("duplicate headers", () => {
  // BUG (medium): dedupeNames appends `_N` based only on how many times the
  // *original* name has been seen, without checking whether that generated
  // name collides with a name that already exists in the file verbatim.
  // "a,a,a_2" should yield three distinct column identities, but the second
  // "a" is renamed to "a_2" — which collides with the third column, which
  // is already literally named "a_2". Two different columns end up sharing
  // one name, which silently breaks anything keyed by header name
  // (columnVisibility, filter rules, sort keys, detail labels, ...).
  test.fails('"a,a,a_2" produces three distinct header names, not a collision', () => {
    const r = parseCsv("a,a,a_2\n1,2,3");
    expect(new Set(r.headers).size).toBe(3);
  });

  test.fails('"a,a,a,a_2" (a longer collision chain) also produces four distinct header names', () => {
    const r = parseCsv("a,a,a,a_2\n1,2,3,4");
    expect(new Set(r.headers).size).toBe(4);
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
  test.fails('using `"` as the custom delimiter is honored (or at least does not silently fall back to auto-detected comma)', () => {
    const r = parseCsv('a"b\n1"2', { delimiter: '"' });
    expect(r.delimiter).toBe('"');
    expect(r.headers).toEqual(["a", "b"]);
    expect(r.rows).toEqual([["1", "2"]]);
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

  test.fails("mixed line endings still corrupt rows when firstRowIsHeader is false (see line-endings bug above)", () => {
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
