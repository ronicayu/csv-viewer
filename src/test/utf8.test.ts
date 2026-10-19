import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isValidUtf8, isValidUtf8Js } from "../utf8";

function fatalDecodeAccepts(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// The bytes where UTF-8's rules change: lead bytes, continuation bounds, surrogates, overlongs, the top of the range.
const EDGE_BYTES = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xff];
const edgeArb = fc.array(fc.constantFrom(...EDGE_BYTES), { maxLength: 12 }).map((b) => Uint8Array.from(b));
const textArb = fc.string({ unit: "binary", maxLength: 12 }).map((s) => new TextEncoder().encode(s));
const bytesArb = fc.oneof(fc.uint8Array({ maxLength: 16 }), edgeArb, textArb, fc.tuple(textArb, edgeArb, textArb).map(([a, b, c]) => Uint8Array.from([...a, ...b, ...c])));

describe("UTF-8 validation without decoding", () => {
  it("the JavaScript validator gives the fatal TextDecoder's verdict on arbitrary bytes (property)", () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        expect(isValidUtf8Js(bytes)).toBe(fatalDecodeAccepts(bytes));
      }),
      { numRuns: 20000 },
    );
  });

  it("so does the validator the host uses, whichever implementation the runtime provides (property)", () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        expect(isValidUtf8(bytes)).toBe(fatalDecodeAccepts(bytes));
      }),
      { numRuns: 10000 },
    );
  });

  it("agrees on a view into a larger buffer, a BOM, and the empty file", () => {
    const pool = new Uint8Array(32).fill(0xff);
    pool.set(new TextEncoder().encode("é,€\n"), 8);
    expect(isValidUtf8(pool.subarray(8, 8 + 7))).toBe(true);
    expect(isValidUtf8(pool)).toBe(false);
    expect(isValidUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe(true);
    expect(isValidUtf8(new Uint8Array(0))).toBe(true);
    expect(isValidUtf8Js(new Uint8Array(0))).toBe(true);
  });
});
