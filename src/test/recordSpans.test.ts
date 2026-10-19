import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { effectiveQuoting, parseCsv } from "../core/csvParse";
import {
  SpanTableBuilder,
  addByteOffsets,
  freshScanState,
  scanRecords,
  spansFromTable,
  splitRecords,
  splitRecordsToTable,
  type RecordSpan,
  type SplitOptions,
} from "../core/recordSpans";

function split(text: string, delimiter = ",", quotes = true): RecordSpan[] {
  return splitRecords(text, { delimiter, quotes });
}

function texts(text: string, spans: RecordSpan[]): string[] {
  return spans.map((s) => text.slice(s.start, s.end));
}

describe("splitRecords: line endings and gaps", () => {
  it("splits LF, CRLF and CR files and keeps each terminator", () => {
    expect(split("a,b\n1,2\n")).toEqual([
      { start: 0, end: 3, eol: "\n", fieldCount: 2 },
      { start: 4, end: 7, eol: "\n", fieldCount: 2 },
    ]);
    expect(split("a,b\r\n1,2\r\n").map((s) => s.eol)).toEqual(["\r\n", "\r\n"]);
    expect(split("a,b\r1,2\r").map((s) => s.eol)).toEqual(["\r", "\r"]);
  });

  it("keeps mixed endings per record", () => {
    const text = "a\r\nb\nc\rd";
    expect(split(text).map((s) => s.eol)).toEqual(["\r\n", "\n", "\r", ""]);
    expect(texts(text, split(text))).toEqual(["a", "b", "c", "d"]);
  });

  it("treats \\n\\r as a terminator followed by an empty line", () => {
    const text = "a\n\rb";
    expect(texts(text, split(text))).toEqual(["a", "b"]);
    expect(split(text).map((s) => s.eol)).toEqual(["\n", ""]);
  });

  it("skips a leading BOM", () => {
    expect(split("﻿a,b\n1,2")[0]).toEqual({ start: 1, end: 4, eol: "\n", fieldCount: 2 });
  });

  it("leaves leading, middle and trailing blank lines out of every span", () => {
    const text = "\n\na,b\n\n\n1,2\n\n";
    expect(texts(text, split(text))).toEqual(["a,b", "1,2"]);
  });

  it("keeps whitespace-only lines as records", () => {
    expect(texts("a\n  \nb", split("a\n  \nb"))).toEqual(["a", "  ", "b"]);
  });

  it("skips a quoted-empty line, with or without trailing spaces, but keeps four quotes and delimiter-only lines", () => {
    expect(texts('a\n""\nb', split('a\n""\nb'))).toEqual(["a", "b"]);
    expect(texts('a\n"" \nb', split('a\n"" \nb'))).toEqual(["a", "b"]);
    expect(texts('a\n""""\nb', split('a\n""""\nb'))).toEqual(["a", '""""', "b"]);
    expect(split("a,b\n,,,\n1,2")[1].fieldCount).toBe(4);
  });

  it("handles a final record with and without a trailing newline", () => {
    expect(split("a\nb").at(-1)).toEqual({ start: 2, end: 3, eol: "", fieldCount: 1 });
    expect(split("a\nb\n").at(-1)).toEqual({ start: 2, end: 3, eol: "\n", fieldCount: 1 });
  });

  it("returns nothing for empty, BOM-only and newline-only text", () => {
    expect(split("")).toEqual([]);
    expect(split("﻿")).toEqual([]);
    expect(split("\n\n\r\n")).toEqual([]);
  });

  it("splits a header-only file into its one record, with and without a final newline", () => {
    expect(split("a,b,c")).toEqual([{ start: 0, end: 5, eol: "", fieldCount: 3 }]);
    expect(split("a,b,c\n")).toEqual([{ start: 0, end: 5, eol: "\n", fieldCount: 3 }]);
  });

  it("counts physical fields for short and long rows and a trailing delimiter", () => {
    expect(split("a,b,c\n1\n1,2,3,4,5\n1,").map((s) => s.fieldCount)).toEqual([3, 1, 5, 2]);
  });
});

describe("splitRecords: quoting", () => {
  it("keeps quoted newlines (LF, CRLF) inside the record", () => {
    const text = 'a,b\n"x\ny",2\n"p\r\nq",3\n';
    expect(texts(text, split(text))).toEqual(["a,b", '"x\ny",2', '"p\r\nq",3']);
  });

  it("treats a doubled quote as an escape", () => {
    const text = '"she said ""hi""",2\nnext';
    expect(texts(text, split(text))).toEqual(['"she said ""hi""",2', "next"]);
  });

  it("closes a quote followed by spaces and then a delimiter, terminator or EOF", () => {
    expect(texts('"a"  ,b\nc', split('"a"  ,b\nc'))).toEqual(['"a"  ,b', "c"]);
    expect(texts('"a"  \nc', split('"a"  \nc'))).toEqual(['"a"  ', "c"]);
    expect(texts('"a"', split('"a"'))).toEqual(['"a"']);
  });

  it("only treats a quote as opening at the start of a field", () => {
    const text = 'a"b,c\nd';
    expect(texts(text, split(text))).toEqual(['a"b,c', "d"]);
    expect(texts('5" pipe,x\ny', split('5" pipe,x\ny'))).toEqual(['5" pipe,x', "y"]);
  });

  it("follows Papa's malformed-quote recovery: h,\"b\"c,d swallows the rest of the line", () => {
    const text = 'h,"b"c,d\nnext\n';
    expect(split(text).length).toBe(parseCsv(text, { firstRowIsHeader: false }).rows.length);
  });

  it("a recurring malformed quote swallows the rest of the file, like Papa", () => {
    const text = 'a,b\n1,"x"y\n2,"z"w\n3,4\n';
    expect(split(text).length).toBe(parseCsv(text, { firstRowIsHeader: false }).rows.length);
  });

  it("runs an unterminated quoted field to EOF", () => {
    const text = 'a\n"never closed\nstill going';
    expect(texts(text, split(text))).toEqual(["a", '"never closed\nstill going']);
    expect(split(text).at(-1)!.eol).toBe("");
  });

  it("treats quotes as literal with quotes: false", () => {
    const text = '"a,b\nc"d\n';
    expect(texts(text, split(text, ",", false))).toEqual(['"a,b', 'c"d']);
  });

  it("supports multi-character delimiters", () => {
    expect(split("a||b||c\n1||2", "||").map((s) => s.fieldCount)).toEqual([3, 2]);
    expect(split('a||"x||y"||c', "||")[0].fieldCount).toBe(3);
  });

  it("supports a quote delimiter when quoting is off, and a tab delimiter", () => {
    expect(split('a"b"c\n1"2"3', '"', false).map((s) => s.fieldCount)).toEqual([3, 3]);
    expect(split("a\tb\n1\t2", "\t").map((s) => s.fieldCount)).toEqual([2, 2]);
  });

  it("NUL in the text forces quoting on (effectiveQuoting)", () => {
    const text = 'a,"b\nc"\u0000';
    const parsed = parseCsv(text, { quotes: false, firstRowIsHeader: false });
    expect(parsed.quoting).toBe(true);
    expect(effectiveQuoting(text, false)).toBe(true);
    expect(split(text, parsed.delimiter, parsed.quoting).length).toBe(parsed.rows.length);
  });
});

describe("span tables", () => {
  it("splitRecordsToTable agrees with splitRecords and addByteOffsets counts UTF-8 bytes", () => {
    const text = "﻿é,€\r\n😀,b\n";
    const table = splitRecordsToTable(text, { delimiter: ",", quotes: true });
    expect(spansFromTable(table)).toEqual(split(text));
    addByteOffsets(table, text);
    const bytes = new TextEncoder().encode(text);
    const slice = (i: number): string => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(table.byteStart![i], table.byteEnd![i]));
    expect(slice(0)).toBe("é,€");
    expect(slice(1)).toBe("😀,b");
    expect(table.byteStart![0]).toBe(3);
  });

  it("byte offsets equal character offsets for ASCII text", () => {
    const text = "a,b\r\n1,2\n";
    const table = splitRecordsToTable(text, { delimiter: ",", quotes: true });
    addByteOffsets(table, text);
    expect(Array.from(table.byteStart!)).toEqual(Array.from(table.start));
    expect(Array.from(table.byteEnd!)).toEqual(Array.from(table.end));
  });

  it("grows past its initial capacity", () => {
    const text = "x\n".repeat(5000);
    const table = splitRecordsToTable(text, { delimiter: ",", quotes: true });
    expect(table.length).toBe(5000);
    expect(table.start[4999]).toBe(9998);
  });
});

describe("span table sizing and byte lengths", () => {
  const table = (text: string) => splitRecordsToTable(text, { delimiter: ",", quotes: true });

  it("a builder sized for the text gives the same table as an unsized one, with exact-length arrays", () => {
    const text = Array.from({ length: 3000 }, (_, i) => `${i},v${i}`).join("\n");
    for (const sizeFor of [0, 10, text.length, text.length * 100]) {
      const builder = new SpanTableBuilder(sizeFor);
      scanRecords(text, { delimiter: ",", quotes: true }, builder.push);
      const sized = builder.finish();
      expect(sized.length).toBe(3000);
      for (const column of [sized.start, sized.end, sized.fieldCount, sized.eol]) expect(column.length).toBe(3000);
      expect(spansFromTable(sized)).toEqual(split(text));
    }
  });

  it("does not keep a mostly empty buffer alive", () => {
    const builder = new SpanTableBuilder(10_000_000);
    scanRecords("a,b\n1,2", { delimiter: ",", quotes: true }, builder.push);
    const small = builder.finish();
    expect(small.length).toBe(2);
    expect(small.start.buffer.byteLength).toBeLessThanOrEqual(small.length * 4 * 2);
  });

  it("byte offsets from a known byte length equal the ones from the text, for ASCII and non-ASCII alike (property)", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(textArb, (text) => {
        const without = table(text);
        const withLength = table(text);
        addByteOffsets(without, text);
        addByteOffsets(withLength, text, encoder.encode(text).length);
        expect(Array.from(withLength.byteStart!)).toEqual(Array.from(without.byteStart!));
        expect(Array.from(withLength.byteEnd!)).toEqual(Array.from(without.byteEnd!));
      }),
      { numRuns: 4000 },
    );
  });

  it("a longer byte length than the text means non-ASCII, even when the table is all ASCII-positioned", () => {
    const text = "a,b\n1,é";
    const t = table(text);
    addByteOffsets(t, text, 9);
    expect(t.byteEnd![1]).toBe(8);
    expect(t.end[1]).toBe(7);
    expect(t.byteStart).not.toBe(t.start);
  });
});

const ALPHABET = ["a", "b", "1", ",", ";", "|", "\t", '"', '"', " ", "\n", "\r", "é", "€", "😀", " "];

const textArb = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 40 }).map((chars) => chars.join(""));

const optionsArb = fc.record({
  delimiter: fc.constantFrom("", ",", ";", "|", "\t", "||", ";;"),
  quotes: fc.boolean(),
  firstRowIsHeader: fc.boolean(),
});

describe("scanRecords can be resumed", () => {
  it("scanning in slices of any size finds the same records as one pass (property)", () => {
    fc.assert(
      fc.property(textArb, optionsArb, fc.integer({ min: 1, max: 4 }), (text, opts, slice) => {
        const parsed = parseCsv(text, opts);
        const options: SplitOptions = { delimiter: parsed.delimiter, quotes: parsed.quoting };
        const builder = new SpanTableBuilder();
        let pos = 0;
        do {
          pos = scanRecords(text, options, builder.push, pos, slice);
        } while (pos < text.length);
        expect(spansFromTable(builder.finish())).toEqual(splitRecords(text, options));
      }),
      { numRuns: 3000 },
    );
  });

  it("carrying a ScanState across slices of varying sizes emits exactly splitRecords (property)", () => {
    fc.assert(
      fc.property(textArb, optionsArb, fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 5 }), (text, opts, sizes) => {
        const parsed = parseCsv(text, opts);
        const options: SplitOptions = { delimiter: parsed.delimiter, quotes: parsed.quoting };
        const builder = new SpanTableBuilder();
        const state = freshScanState();
        let pos = 0;
        for (let call = 0; ; call++) {
          pos = scanRecords(text, options, builder.push, pos, sizes[call % sizes.length], state);
          if (pos >= text.length) break;
        }
        expect(spansFromTable(builder.finish())).toEqual(splitRecords(text, options));
      }),
      { numRuns: 5000 },
    );
  });

  it("a final unsliced call with the carried state finishes the scan like one pass (property)", () => {
    fc.assert(
      fc.property(textArb, optionsArb, fc.integer({ min: 1, max: 6 }), (text, opts, first) => {
        const parsed = parseCsv(text, opts);
        const options: SplitOptions = { delimiter: parsed.delimiter, quotes: parsed.quoting };
        const builder = new SpanTableBuilder();
        const state = freshScanState();
        const pos = scanRecords(text, options, builder.push, 0, first, state);
        scanRecords(text, options, builder.push, pos, Infinity, state);
        expect(spansFromTable(builder.finish())).toEqual(splitRecords(text, options));
      }),
      { numRuns: 3000 },
    );
  });

  it("slicing does not repeat the searches: the same indexOf calls per needle as one pass", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `${i},v${i},x`).join("\n");
    const options: SplitOptions = { delimiter: ",", quotes: true };
    const countNeedles = (scan: () => void): Map<string, number> => {
      const counts = new Map<string, number>();
      const original = String.prototype.indexOf;
      const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, needle: string, from?: number) {
        counts.set(needle, (counts.get(needle) ?? 0) + 1);
        return original.call(this, needle, from);
      });
      try {
        scan();
      } finally {
        spy.mockRestore();
      }
      return counts;
    };

    const onePass = countNeedles(() => scanRecords(text, options, () => {}));
    const sliced = countNeedles(() => {
      const state = freshScanState();
      let pos = 0;
      do {
        pos = scanRecords(text, options, () => {}, pos, 100, state);
      } while (pos < text.length);
    });

    // The text has no CR, so one pass looks for it exactly once.
    expect(onePass.get("\r")).toBe(1);
    expect(sliced.get("\r")).toBe(1);
    expect(sliced.get(",")).toBe(onePass.get(","));
    expect(sliced.get("\n")).toBe(onePass.get("\n"));
  });
});

describe("splitRecords agrees with Papa (property tests)", () => {
  it("record count equals parseCsv's row count plus the header", () => {
    fc.assert(
      fc.property(textArb, optionsArb, (text, opts) => {
        const parsed = parseCsv(text, opts);
        const spans = splitRecords(text, { delimiter: parsed.delimiter, quotes: parsed.quoting });
        const headerRecords = opts.firstRowIsHeader && parsed.headers.length > 0 ? 1 : 0;
        expect(spans.length).toBe(parsed.rows.length + headerRecords);
      }),
      { numRuns: 4000 },
    );
  });

  it("spans, terminators and gaps tile the text, and every gap holds only skipped blank lines", () => {
    fc.assert(
      fc.property(textArb, optionsArb, (text, opts) => {
        const parsed = parseCsv(text, opts);
        const options: SplitOptions = { delimiter: parsed.delimiter, quotes: parsed.quoting };
        const spans = splitRecords(text, options);
        let cursor = text.charCodeAt(0) === 0xfeff ? 1 : 0;
        let rebuilt = text.slice(0, cursor);
        for (const span of spans) {
          expect(span.start).toBeGreaterThanOrEqual(cursor);
          const gap = text.slice(cursor, span.start);
          expect(parseCsv(gap, { delimiter: parsed.delimiter, quotes: parsed.quoting, firstRowIsHeader: false }).rows).toEqual([]);
          expect(text.startsWith(span.eol, span.end)).toBe(true);
          rebuilt += gap + text.slice(span.start, span.end) + span.eol;
          cursor = span.end + span.eol.length;
        }
        const tail = text.slice(cursor);
        expect(parseCsv(tail, { delimiter: parsed.delimiter, quotes: parsed.quoting, firstRowIsHeader: false }).rows).toEqual([]);
        expect(rebuilt + tail).toBe(text);
      }),
      { numRuns: 4000 },
    );
  });

  it("each span parsed in isolation is exactly Papa's row, and fieldCount is its unpadded length", () => {
    fc.assert(
      fc.property(textArb, optionsArb, (text, opts) => {
        const whole = parseCsv(text, { ...opts, firstRowIsHeader: false });
        const spans = splitRecords(text, { delimiter: whole.delimiter, quotes: whole.quoting });
        expect(spans.length).toBe(whole.rows.length);
        spans.forEach((span, i) => {
          // The terminator is part of the input: `"a" ` only closes its quote when something follows the spaces.
          const isolated = parseCsv(text.slice(span.start, span.end + span.eol.length), {
            delimiter: whole.delimiter,
            quotes: whole.quoting,
            firstRowIsHeader: false,
          });
          expect(isolated.rows.length).toBe(1);
          expect(isolated.rows[0].length).toBe(span.fieldCount);
          expect(isolated.rows[0]).toEqual(whole.rows[i].slice(0, span.fieldCount));
          expect(whole.rows[i].slice(span.fieldCount).every((f) => f === "")).toBe(true);
        });
      }),
      { numRuns: 4000 },
    );
  });
});
