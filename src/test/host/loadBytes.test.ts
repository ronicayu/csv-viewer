import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { parseCsv } from "../../core/csvParse";
import * as fake from "./fakeVscode";
import { loadText, openSession } from "./harness";

// What the host used to send as the load message's text.
function hostDecode(bytes: Uint8Array): { text: string; lossy: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), lossy: false };
  } catch {
    return { text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes), lossy: true };
  }
}

let counter = 0;
const nextPath = (): string => `/h/lb${++counter}.csv`;

const PIECES = ["a", "b", ",", ";", "\n", "\r\n", "\r", '"', " ", "é", "€", "😀", "\u0000", "﻿", " "];
const validArb = fc.array(fc.constantFrom(...PIECES), { maxLength: 30 }).map((p) => new TextEncoder().encode(p.join("")));
// Arbitrary bytes are mostly invalid UTF-8; splicing them into valid text puts the invalid sequence anywhere.
const mixedArb = fc.tuple(validArb, fc.uint8Array({ maxLength: 6 }), validArb).map(([a, junk, b]) => Uint8Array.from([...a, ...junk, ...b]));

describe("the load message carries the file's bytes", () => {
  it("decoded in the webview they are the string the host used to send, lossy or not, and the worker parses that (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(validArb, mixedArb, fc.uint8Array({ maxLength: 12 })), async (bytes) => {
        const s = await openSession(nextPath(), bytes);
        const message = s.of("load")[0];
        const old = hostDecode(bytes);

        expect(message.text).toBeUndefined();
        expect(Array.from(new Uint8Array(message.bytes))).toEqual(Array.from(bytes));
        expect(loadText(message)).toBe(old.text);
        expect(s.text).toBe(old.text);
        expect(message.editable).toBe(!old.lossy);
        if (old.lossy) expect(message.readOnlyReason).toBe("encoding");
        s.dispose();
      }),
      { numRuns: 400 },
    );
  });

  it("is exactly the file even when readFile returns a view into a larger buffer", async () => {
    const original = "id,name\r\n1,é\r\n";
    const data = new TextEncoder().encode(original);
    const pool = new Uint8Array(data.length + 100);
    pool.set(data, 50);
    const spy = vi.spyOn(fake.workspace.fs, "readFile").mockImplementation(async () => pool.subarray(50, 50 + data.length));
    try {
      const s = await openSession(nextPath(), original);
      const bytes: ArrayBuffer = s.of("load")[0].bytes;
      expect(bytes.byteLength).toBe(data.length);
      expect(loadText(s.of("load")[0])).toBe(original);
      s.dispose();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a BOM, non-ASCII text and CRLF as cells exactly as before", async () => {
    const file = "\u{feff}name,note\r\nÅsa,\"naïve, café\"\r\n日本,😀\r\n";
    const s = await openSession(nextPath(), file);
    expect(s.text.charCodeAt(0)).toBe(0xfeff);
    expect(s.text).toBe(file);
    expect(s.headers).toEqual(parseCsv(file).headers);
    expect(s.headers).toEqual(["name", "note"]);
  });
});
