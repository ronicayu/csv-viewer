import { describe, expect, it } from "vitest";
import { parseCsv, stripBom } from "../core/csvParse";

describe("stripBom", () => {
  it("removes a leading BOM", () => {
    expect(stripBom("﻿a,b")).toBe("a,b");
  });

  it("leaves text without a BOM untouched", () => {
    expect(stripBom("a,b")).toBe("a,b");
  });
});

describe("parseCsv basics", () => {
  it("parses a simple comma file with a header row", () => {
    const result = parseCsv("a,b,c\n1,2,3\n4,5,6");
    expect(result.headers).toEqual(["a", "b", "c"]);
    expect(result.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("returns empty headers and rows for empty input", () => {
    const result = parseCsv("");
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("does not produce an empty trailing row for a trailing newline", () => {
    const result = parseCsv("a,b\n1,2\n");
    expect(result.rows).toEqual([["1", "2"]]);
  });

  it("handles a final row with no trailing newline", () => {
    const result = parseCsv("a,b\n1,2");
    expect(result.rows).toEqual([["1", "2"]]);
  });

  it("skips a fully blank line in the middle of the file rather than producing an empty row", () => {
    const result = parseCsv("a,b\n1,2\n\n3,4\n");
    expect(result.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("quoted fields", () => {
  it("parses quoted fields containing the delimiter", () => {
    const result = parseCsv('a,b\n"1,2",3');
    expect(result.rows).toEqual([["1,2", "3"]]);
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    const result = parseCsv('a\n"she said ""hi"""');
    expect(result.rows).toEqual([['she said "hi"']]);
  });

  it("preserves embedded newlines inside a quoted field", () => {
    const result = parseCsv('a,b\n"line1\nline2",x');
    expect(result.rows).toEqual([["line1\nline2", "x"]]);
  });

  it("normalizes an embedded CRLF inside a quoted field to LF", () => {
    const result = parseCsv('a,b\n"line1\r\nline2",x');
    expect(result.rows).toEqual([["line1\nline2", "x"]]);
  });

  it("preserves a quoted field containing a newline followed by a comma", () => {
    const result = parseCsv('a,b\n"line1,\nline2",x');
    expect(result.rows).toEqual([["line1,\nline2", "x"]]);
  });
});

describe("stray mid-field quote regression (the bug Papa Parse fixes)", () => {
  it("parses an inch mark inside an unquoted field as literal text, not a quote-open", () => {
    const result = parseCsv('name,size,type\nWidget,5" screen,TV\nGadget,10" screen,Monitor');
    expect(result.headers).toEqual(["name", "size", "type"]);
    expect(result.headers.length).toBe(3);
    expect(result.rows).toEqual([
      ["Widget", '5" screen', "TV"],
      ["Gadget", '10" screen', "Monitor"],
    ]);
  });

  it("parses a stray quote mid-field with a following comma without swallowing the rest of the file", () => {
    const result = parseCsv('a,b\n1,5" screen,TV');
    expect(result.rows).toEqual([["1", '5" screen', "TV"]]);
  });

  it('parses `He said "hi" there` mid-field as literal text', () => {
    const result = parseCsv('a,b\n1,He said "hi" there,x');
    expect(result.rows).toEqual([["1", 'He said "hi" there', "x"]]);
  });
});

describe("line endings", () => {
  it("parses CRLF-separated rows", () => {
    const result = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(result.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("parses CR-only-separated rows", () => {
    const result = parseCsv("a,b\r1,2\r3,4");
    expect(result.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("parses LF-separated rows", () => {
    const result = parseCsv("a,b\n1,2\n3,4");
    expect(result.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("ragged rows", () => {
  it("pads short rows with empty strings", () => {
    const result = parseCsv("a,b,c\n1,2");
    expect(result.rows).toEqual([["1", "2", ""]]);
  });

  it("gives extra cells beyond the header auto-generated names", () => {
    const result = parseCsv("a,b\n1,2,3,4");
    expect(result.headers).toEqual(["a", "b", "column_3", "column_4"]);
    expect(result.rows).toEqual([["1", "2", "3", "4"]]);
  });
});

describe("headers", () => {
  it("dedupes duplicate header names", () => {
    const result = parseCsv("name,name,age\n1,2,3");
    expect(result.headers).toEqual(["name", "name_2", "age"]);
  });

  it("names empty header cells with a positional column name", () => {
    const result = parseCsv("a,,c\n1,2,3");
    expect(result.headers).toEqual(["a", "column_2", "c"]);
  });

  it("synthesizes column_N headers when firstRowIsHeader is false", () => {
    const result = parseCsv("1,2,3\n4,5,6", { firstRowIsHeader: false });
    expect(result.headers).toEqual(["column_1", "column_2", "column_3"]);
    expect(result.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });
});

describe("delimiter auto-detection (via parseCsv's returned delimiter)", () => {
  it("detects comma", () => {
    expect(parseCsv("a,b,c\n1,2,3\n4,5,6").delimiter).toBe(",");
  });

  it("detects semicolon", () => {
    expect(parseCsv("a;b;c\n1;2;3\n4;5;6").delimiter).toBe(";");
  });

  it("detects tab", () => {
    expect(parseCsv("a\tb\tc\n1\t2\t3").delimiter).toBe("\t");
  });

  it("detects pipe", () => {
    expect(parseCsv("a|b|c\n1|2|3").delimiter).toBe("|");
  });

  it("defaults to comma for empty input", () => {
    expect(parseCsv("").delimiter).toBe(",");
  });

  it("prefers the delimiter with the most consistent count across lines", () => {
    const text = "a;b\n1,1;2\n3;4,4,4\n5;6";
    expect(parseCsv(text).delimiter).toBe(";");
  });

  it("detects semicolon correctly even when a quoted field contains many semicolons", () => {
    const text = 'a;b;c\n1;"x;y;z;w";3\n4;"p;q;r;s";6';
    const result = parseCsv(text);
    expect(result.delimiter).toBe(";");
    expect(result.rows).toEqual([
      ["1", "x;y;z;w", "3"],
      ["4", "p;q;r;s", "6"],
    ]);
  });

  it("parses semicolon-delimited European decimals without splitting on the decimal comma", () => {
    const result = parseCsv('1;1,50;"A"', { firstRowIsHeader: false });
    expect(result.delimiter).toBe(";");
    expect(result.headers).toEqual(["column_1", "column_2", "column_3"]);
    expect(result.rows).toEqual([["1", "1,50", "A"]]);
  });

  it("still reports the single detectable delimiter for a single-column file", () => {
    const result = parseCsv("a\n1\n2\n3");
    expect(result.headers).toEqual(["a"]);
    expect(result.rows).toEqual([["1"], ["2"], ["3"]]);
  });
});

describe("explicit delimiter option", () => {
  it("uses the given delimiter instead of detecting one", () => {
    const result = parseCsv("a\tb\n1\t2", { delimiter: "\t" });
    expect(result.headers).toEqual(["a", "b"]);
    expect(result.rows).toEqual([["1", "2"]]);
  });

  it("treats an empty-string delimiter the same as undefined (auto-detect)", () => {
    const result = parseCsv("a;b\n1;2", { delimiter: "" });
    expect(result.delimiter).toBe(";");
    expect(result.rows).toEqual([["1", "2"]]);
  });

  it("supports a multi-character custom delimiter", () => {
    const result = parseCsv("a||b||c\n1||2||3", { delimiter: "||" });
    expect(result.delimiter).toBe("||");
    expect(result.headers).toEqual(["a", "b", "c"]);
    expect(result.rows).toEqual([["1", "2", "3"]]);
  });

  it("returns the delimiter actually used so the UI can show it", () => {
    expect(parseCsv("a,b\n1,2").delimiter).toBe(",");
    expect(parseCsv("a\tb\n1\t2", { delimiter: "\t" }).delimiter).toBe("\t");
  });
});

describe("quoteProblems", () => {
  it("reports the row where a bad quote swallows the rest of the file", () => {
    const result = parseCsv('a,b\n"b"c,d\ne,f\ng,h\n');
    expect(result.quoteProblems.map((p) => p.row)).toContain(1);
  });

  it("does not report a mid-field quote, which parses correctly as literal text", () => {
    const result = parseCsv('id,size,name\n1,5" screen,TV\n2,10,Radio\n');
    expect(result.quoteProblems).toEqual([]);
    expect(result.rows).toEqual([["1", '5" screen', "TV"], ["2", "10", "Radio"]]);
  });

  it("does not report a well-formed quoted field spanning several lines", () => {
    const result = parseCsv('a,b\n"line one\nline two, with comma\nline three",2\n3,4\n');
    expect(result.quoteProblems).toEqual([]);
    expect(result.rows).toHaveLength(2);
  });
});
