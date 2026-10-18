import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../core/csvParse";
import { needsQuotes, serializeField, serializeRecord, utf8Length } from "../core/csvSerialize";

describe("needsQuotes", () => {
  it("quotes a field with the delimiter, a quote, or a line break", () => {
    expect(needsQuotes("a,b", ",")).toBe(true);
    expect(needsQuotes('say "hi"', ",")).toBe(true);
    expect(needsQuotes("a\nb", ",")).toBe(true);
    expect(needsQuotes("a\rb", ",")).toBe(true);
  });

  it("quotes leading and trailing spaces and tabs only", () => {
    expect(needsQuotes(" a", ",")).toBe(true);
    expect(needsQuotes("a ", ",")).toBe(true);
    expect(needsQuotes("\ta", ",")).toBe(true);
    expect(needsQuotes("a b", ",")).toBe(false);
  });

  it("never quotes an empty field", () => {
    expect(needsQuotes("", ",")).toBe(false);
  });

  it("uses the actual delimiter: a comma is plain in a tab file, a tab needs quotes", () => {
    expect(needsQuotes("a,b", "\t")).toBe(false);
    expect(needsQuotes("a\tb", "\t")).toBe(true);
  });

  it("matches a multi-character delimiter as a whole, not by its characters", () => {
    expect(needsQuotes("a|b", "||")).toBe(false);
    expect(needsQuotes("a||b", "||")).toBe(true);
  });

  it("quotes a field ending in the start of a multi-character delimiter, which would otherwise merge with it", () => {
    expect(needsQuotes("a|", "||")).toBe(true);
    expect(parseCsv(serializeRecord(["a|", "b"], "||", true), { delimiter: "||", firstRowIsHeader: false }).rows[0]).toEqual(["a|", "b"]);
  });
});

describe("serializeField / serializeRecord", () => {
  it("doubles embedded quotes inside the wrapper", () => {
    expect(serializeField('a"b', ",", true)).toBe('"a""b"');
  });

  it("returns plain fields as they are", () => {
    expect(serializeField("plain", ",", true)).toBe("plain");
  });

  it("with quoting off returns null for a separator or line break and writes quotes literally", () => {
    expect(serializeField("a,b", ",", false)).toBeNull();
    expect(serializeField("a\nb", ",", false)).toBeNull();
    expect(serializeField('5" pipe', ",", false)).toBe('5" pipe');
  });

  it("joins with the delimiter and no terminator", () => {
    expect(serializeRecord(["a", "b,c", ""], ",", true)).toBe('a,"b,c",');
  });

  it("throws rather than write a field it cannot represent", () => {
    expect(() => serializeRecord(["a,b"], ",", false)).toThrow();
  });
});

describe("utf8Length", () => {
  it("matches TextEncoder for ASCII, 2/3/4-byte characters and U+FEFF", () => {
    for (const s of ["", "abc", "é", "€", "😀", "﻿x", "a😀b€é"]) {
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
    }
  });

  it("measures a slice", () => {
    expect(utf8Length("a€b", 1, 2)).toBe(3);
  });

  it("matches TextEncoder for arbitrary strings, including lone surrogates (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (s) => {
        expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("round trip through parseCsv (property)", () => {
  const fieldArb = fc
    .array(fc.constantFrom("a", "1", ",", ";", "|", "\t", '"', " ", "\n", "é", "😀", " "), { maxLength: 8 })
    .map((chars) => chars.join(""));
  const fieldsArb = fc.array(fieldArb, { minLength: 1, maxLength: 6 }).filter((f) => !(f.length === 1 && f[0] === ""));

  it("parseCsv(serializeRecord(fields)) is fields, for any delimiter, with quoting on", () => {
    fc.assert(
      fc.property(fieldsArb, fc.constantFrom(",", ";", "|", "\t", "||"), (fields, delimiter) => {
        const text = serializeRecord(fields, delimiter, true);
        const parsed = parseCsv(text, { delimiter, firstRowIsHeader: false });
        expect(parsed.rows).toEqual([fields]);
      }),
      { numRuns: 4000 },
    );
  });
});
