import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, stripBom } from "../core/csvParse";

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

  it("preserves embedded CRLF inside a quoted field", () => {
    const result = parseCsv('a,b\n"line1\r\nline2",x');
    expect(result.rows).toEqual([["line1\r\nline2", "x"]]);
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

describe("detectDelimiter", () => {
  it("detects comma", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n4,5,6")).toBe(",");
  });

  it("detects semicolon", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n4;5;6")).toBe(";");
  });

  it("detects tab", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("detects pipe", () => {
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
  });

  it("defaults to comma for empty input", () => {
    expect(detectDelimiter("")).toBe(",");
  });

  it("prefers the delimiter with the most consistent count across lines", () => {
    // Semicolons appear exactly once on every line (fully consistent).
    // Commas appear a varying number of times on only some lines. Comma's
    // raw occurrence count is higher on one line, but semicolon should
    // still win because consistency is weighted above raw frequency.
    const text = "a;b\n1,1;2\n3;4,4,4\n5;6";
    expect(detectDelimiter(text)).toBe(";");
  });
});

describe("explicit delimiter option", () => {
  it("uses the given delimiter instead of detecting one", () => {
    const result = parseCsv("a\tb\n1\t2", { delimiter: "\t" });
    expect(result.headers).toEqual(["a", "b"]);
    expect(result.rows).toEqual([["1", "2"]]);
  });
});
