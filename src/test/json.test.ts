import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatJsonText, tryParseJsonValue } from "../core/json";

describe("formatJsonText", () => {
  it("keeps integers above 2^53 exactly as written", () => {
    const out = formatJsonText('{"id":9007199254740993,"big":12345678901234567890}');
    expect(out).toBe('{\n  "id": 9007199254740993,\n  "big": 12345678901234567890\n}');
  });

  it("keeps number formatting (trailing zeros, exponents) as written", () => {
    expect(formatJsonText('{"price":1.10,"e":1E+3,"n":-0.0}')).toBe('{\n  "price": 1.10,\n  "e": 1E+3,\n  "n": -0.0\n}');
  });

  it("keeps duplicate keys", () => {
    expect(formatJsonText('{"a":1,"a":2}')).toBe('{\n  "a": 1,\n  "a": 2\n}');
  });

  it("copies string literals verbatim, including structural characters and escapes", () => {
    const text = '{"k":"a, b: {c} [d] \\"quoted\\" \\\\ \\u00e9","end\\"":"x"}';
    expect(formatJsonText(text)).toBe('{\n  "k": "a, b: {c} [d] \\"quoted\\" \\\\ \\u00e9",\n  "end\\"": "x"\n}');
  });

  it("keeps empty containers on one line and indents nesting by two spaces", () => {
    expect(formatJsonText('{"a":{},"b":[ ],"c":[1,[2,{"d":null}]]}')).toBe(
      '{\n  "a": {},\n  "b": [],\n  "c": [\n    1,\n    [\n      2,\n      {\n        "d": null\n      }\n    ]\n  ]\n}',
    );
  });

  it("normalizes existing whitespace outside strings", () => {
    expect(formatJsonText('  {\n\t"a" :  1 ,\r\n "b":[ true ,false ]\n}  ')).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    false\n  ]\n}');
  });

  it("matches JSON.stringify(value, null, 2) for any ordinary JSON object or array", () => {
    fc.assert(
      fc.property(fc.oneof(fc.dictionary(fc.string(), fc.jsonValue()), fc.array(fc.jsonValue())), (value) => {
        const compact = JSON.stringify(value);
        expect(formatJsonText(compact)).toBe(JSON.stringify(JSON.parse(compact), null, 2));
      }),
      { numRuns: 500 },
    );
  });

  it("only applies to text that tryParseJsonValue accepts", () => {
    expect(tryParseJsonValue('{"id":9007199254740993}')).not.toBeNull();
    expect(tryParseJsonValue("{not json}")).toBeNull();
  });
});
