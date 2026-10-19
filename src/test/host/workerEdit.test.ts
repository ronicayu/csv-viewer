import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyTextPatches, recordFieldsForWrite, spliceBytes } from "../../core/csvEdit";
import { parseCsv } from "../../core/csvParse";
import { splitRecords } from "../../core/recordSpans";
import { utf8Length } from "../../core/csvSerialize";
import { bootHost, callWorker, workerMessages, workerReply } from "./harness";

async function worker(): Promise<void> {
  await bootHost();
}

const init = (text: string, options: { delimiter?: string; firstRowIsHeader?: boolean; quotes?: boolean } = {}) =>
  workerReply({ type: "init", text, options: { firstRowIsHeader: true, quotes: true, ...options } }, "initResult");

const edit = (rowId: number, columnIndex: number, value: string) => workerReply({ type: "editCell", rowId, columnIndex, value }, "editResult");

// Includes characters Papa trims, a BOM, and the NEL that it does not.
const ALPHABET = ["a", "b", "1", ",", ";", "|", "||", '"', " ", "\n", "\r", "\r\n", "é", "😀", "\t", " ", "　", "﻿", "\u0085"];
const textArb = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 40 }).map((c) => c.join(""));
const valueArb = fc
  .array(fc.constantFrom("a", ",", ";", "|", '"', " ", "\n", "é", "😀", "\t", " ", "﻿", "\u0000", ""), { maxLength: 6 })
  .map((c) => c.join(""));

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { ignoreBOM: true });

describe("worker edit pipeline (property)", () => {
  it("accepted edits splice to a file that re-parses, with the options it was edited under, to the intended table", async () => {
    await worker();
    let accepted = 0;
    fc.assert(
      fc.property(
        textArb,
        fc.constantFrom(undefined, ",", ";", "||", " ;", "ab", "\t", "|", '"'),
        fc.boolean(),
        fc.boolean(),
        fc.array(fc.tuple(fc.nat(), fc.nat({ max: 5 }), valueArb), { minLength: 1, maxLength: 4 }),
        (text, delimiter, firstRowIsHeader, quotes, picks) => {
          if (delimiter === '"' && quotes) return;
          if (text.startsWith("﻿﻿")) return;
          const options = { delimiter, firstRowIsHeader, quotes };
          const initResult = init(text, options);
          if (initResult.spansOk === false || initResult.totalRows === 0) return;
          const before = parseCsv(text, options);
          const expected = before.rows.map((r) => r.slice());
          const written = new Map<number, string[]>();
          const originals = new Map<number, string[]>();
          const touched = new Set<number>();
          let format: { delimiter: string; quoting: boolean } | undefined;
          for (const [pick, column, value] of picks) {
            const rowId = pick % before.rows.length;
            const columnIndex = column % before.headers.length;
            const result = edit(rowId, columnIndex, value);
            if (!result.ok || !result.change) continue;
            accepted++;
            const change = result.change;
            format = change.format;
            originals.set(change.recordIndex, change.record.originalFields);
            const record = written.get(change.recordIndex) ?? change.record.originalFields.slice();
            while (record.length <= columnIndex) record.push("");
            record[columnIndex] = value;
            written.set(change.recordIndex, record);
            touched.add(change.recordIndex);
            expected[rowId][columnIndex] = value;
          }
          if (!format) return;

          const bytes = enc.encode(text);
          const table = splitRecords(text, { delimiter: before.delimiter, quotes: before.quoting });
          const records = [...touched]
            .sort((a, b) => a - b)
            .map((index) => ({ index, fields: recordFieldsForWrite(originals.get(index)!, written.get(index)!, table[index].fieldCount, before.headers.length) }));
          const byteStart = (i: number) => utf8Length(text, 0, table[i].start);
          const byteEnd = (i: number) => utf8Length(text, 0, table[i].end);
          const out = dec.decode(
            spliceBytes(bytes, records.map((r) => ({ byteStart: byteStart(r.index), byteEnd: byteEnd(r.index), fields: r.fields })), format.delimiter, format.quoting),
          );

          const context = JSON.stringify({ text, options, picks, out });
          const after = parseCsv(out, { ...options, delimiter: format.delimiter });
          expect(after.headers, context).toEqual(before.headers);
          expect(after.rows, context).toEqual(expected);

          const rebased = workerReply({ type: "rebase", written: records.map((r) => ({ recordIndex: r.index, fields: r.fields })) }, "rebased");
          expect(applyTextPatches(text, rebased.patches), context).toBe(out);
          const resplit = splitRecords(out, { delimiter: after.delimiter, quotes: after.quoting });
          expect(resplit.length, context).toBe(after.rows.length + (firstRowIsHeader && after.headers.length > 0 ? 1 : 0));
        },
      ),
      { numRuns: 30000 },
    );
    expect(accepted).toBeGreaterThan(500);
  });
});

describe("worker edit refusals", () => {
  it("quotes off, multi-character separator: the whole record the host will write is checked, including pending cells to the right", async () => {
    await worker();
    init("a||b||c\nq\nr||s||t\n", { delimiter: "||", quotes: false });
    expect(edit(0, 2, "x")).toMatchObject({ ok: true });
    expect(edit(0, 0, "a|")).toMatchObject({ ok: false });
    expect(edit(0, 0, "a")).toMatchObject({ ok: true });
  });

  it("a floor handed in with init decides how far a record may shrink", async () => {
    await worker();
    const text = "a,b,c\nq,,x\nz,z,z\n";
    workerReply({ type: "init", text, options: { firstRowIsHeader: true, quotes: true }, floors: [{ recordIndex: 1, floor: 1 }] }, "initResult");
    expect(edit(0, 2, "")).toMatchObject({ ok: true });
    expect(edit(0, 0, "")).toMatchObject({ ok: true });
    // what the worker would write for the record if the host said nothing: two empty fields, not three
    const rebased = workerReply({ type: "rebase" }, "rebased");
    expect(applyTextPatches(text, rebased.patches)).toBe("a,b,c\n,\nz,z,z\n");
    // without the floor the worker takes the saved field count (3) as the floor
    init(text);
    expect(edit(0, 2, "")).toMatchObject({ ok: true });
    expect(edit(0, 0, "")).toMatchObject({ ok: true });
    expect(applyTextPatches(text, workerReply({ type: "rebase" }, "rebased").patches)).toBe("a,b,c\n,,\nz,z,z\n");
  });

  it("quotes off: a NUL cannot be added or removed, because that is what turns quoting back on", async () => {
    await worker();
    init("a,b\n1,2\n", { quotes: false });
    expect(edit(0, 0, "x\u0000y")).toMatchObject({ ok: false });
    const forced = init("a\n\u0000\n", { quotes: false });
    expect(forced.quoting).toBe(true);
    expect(edit(0, 0, '"')).toMatchObject({ ok: false });
    // a quotes-on file may change a NUL freely
    init("a\n\u0000\n", { quotes: true });
    expect(edit(0, 0, "ok")).toMatchObject({ ok: true });
  });

  it("an empty value in a one-column file would drop the row, so it is refused; in a wider file the row stays, as two empty fields", async () => {
    await worker();
    init("name\nalpha\nbeta\n");
    expect(edit(0, 0, "")).toMatchObject({ ok: false, reason: "an empty value would leave this row empty, which removes it from the file" });
    init("a,b,c\nq\nz,z,z\n");
    expect(edit(0, 0, "")).toMatchObject({ ok: true });
    expect(applyTextPatches("a,b,c\nq\nz,z,z\n", workerReply({ type: "rebase" }, "rebased").patches)).toBe("a,b,c\n,\nz,z,z\n");
  });

  it("with quoting off a value with the separator is refused", async () => {
    await worker();
    init("a;b\n1;2\n", { delimiter: ";", quotes: false });
    expect(edit(0, 0, "x;y")).toMatchObject({ ok: false });
  });

  it("a double leading BOM keeps its second U+FEFF, so editing the first record is refused rather than losing it", async () => {
    await worker();
    init("﻿﻿a,b\nc,d\n", { firstRowIsHeader: false });
    expect(edit(0, 0, "x")).toMatchObject({ ok: false });
    expect(edit(1, 0, "x")).toMatchObject({ ok: true });
  });

  it("a record that starts with a BOM in the middle of the file is editable", async () => {
    await worker();
    init("a,b\n﻿c,d\ne,f\n");
    const result = edit(0, 1, "D");
    expect(result.ok).toBe(true);
    expect(result.change.record.originalText).toBe("﻿c,d");
  });

  it("a value that begins with a BOM cannot be written at the very start of the file", async () => {
    await worker();
    init("a,b\nc,d\n", { firstRowIsHeader: false });
    expect(edit(0, 0, "﻿x")).toMatchObject({ ok: false });
    expect(edit(1, 0, "﻿x")).toMatchObject({ ok: true });
  });
});

describe("worker spans for large files", () => {
  it("byte offsets stay exact past an 8 MB ASCII prefix, before and after the background span pass finishes", async () => {
    await worker();
    const head = "id,v\n" + "1,aaaaaaaaaa\n".repeat(700_000);
    const text = head + "2,é\n" + "3,x\r\n4,y";
    expect(text.length).toBeGreaterThan(8 * 1024 * 1024);
    const result = init(text);
    expect(result.spansOk).toBeUndefined();
    const last = 700_000 + 2;
    const early = edit(last, 1, "Z");
    const record = early.change.record;
    expect(record.byteStart).toBe(utf8Length(text, 0, record.charStart));
    expect(record.byteEnd).toBe(utf8Length(text, 0, record.charEnd));
    expect(record.byteEnd - record.charEnd).toBe(1);

    const rebased = workerReply({ type: "rebase", written: [{ recordIndex: last + 1, fields: ["4", "Z"] }] }, "rebased");
    const patched = applyTextPatches(text, rebased.patches);
    expect(patched.endsWith("3,x\r\n4,Z")).toBe(true);
    const next = edit(700_001, 1, "ü");
    expect(next.change.record.byteStart).toBe(utf8Length(patched, 0, next.change.record.charStart));
  }, 60000);

  it("the background span pass finishes in slices and agrees with the one-shot split", async () => {
    await worker();
    const text = "id,v\n" + "1,aaaaaaaaaa\n".repeat(700_000) + "2,é\n" + "3,x\r\n4,y";
    const result = init(text);
    expect(result.spansOk).toBeUndefined();
    const seen = workerMessages().length;
    const deadline = Date.now() + 30_000;
    while (!workerMessages().slice(seen).some((m) => m.type === "spansReady") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(workerMessages().slice(seen).filter((m) => m.type === "spansReady")).toEqual([{ type: "spansReady", requestId: result.requestId, spansOk: true }]);
    const last = 700_000 + 2;
    const record = edit(last, 1, "Z").change.record;
    const spans = splitRecords(text, { delimiter: ",", quotes: true });
    expect(record).toMatchObject({ charStart: spans[last + 1].start, charEnd: spans[last + 1].end, fieldCount: 2 });
  }, 60000);

  it("an all-ASCII file that gains a multi-byte character reports exact byte offsets afterwards", async () => {
    await worker();
    init("a,b\n1,2\n3,4\n5,6\n");
    edit(0, 1, "😀é");
    const rebased = workerReply({ type: "rebase", written: [{ recordIndex: 1, fields: ["1", "😀é"] }] }, "rebased");
    const patched = applyTextPatches("a,b\n1,2\n3,4\n5,6\n", rebased.patches);
    const next = edit(2, 0, "q");
    expect(next.change.record.byteStart).toBe(utf8Length(patched, 0, next.change.record.charStart));
    expect(next.change.record.byteEnd).toBe(utf8Length(patched, 0, next.change.record.charEnd));
  });

  it("a known byte length settles ASCII for the first edit, and is dropped once the text has been patched", async () => {
    await worker();
    const ascii = "a,b\n1,2\n3,4\n5,6\n";
    workerReply({ type: "init", text: ascii, byteLength: ascii.length, options: { firstRowIsHeader: true, quotes: true } }, "initResult");
    edit(0, 1, "😀é");
    const rebased = workerReply({ type: "rebase", written: [{ recordIndex: 1, fields: ["1", "😀é"] }] }, "rebased");
    const patched = applyTextPatches(ascii, rebased.patches);
    const next = edit(2, 0, "q");
    expect(next.change.record.byteStart).toBe(utf8Length(patched, 0, next.change.record.charStart));
    expect(next.change.record.byteEnd).toBe(utf8Length(patched, 0, next.change.record.charEnd));

    const wide = "a,b\né,2\n3,€\n";
    const bytes = new TextEncoder().encode(wide).length;
    workerReply({ type: "init", text: wide, byteLength: bytes, options: { firstRowIsHeader: true, quotes: true } }, "initResult");
    const record = edit(1, 0, "x").change.record;
    expect(record.byteStart).toBe(utf8Length(wide, 0, record.charStart));
    expect(record.byteEnd).toBe(utf8Length(wide, 0, record.charEnd));
  });

  it("a rebase without the host's account folds in every edited cell", async () => {
    await worker();
    init("a,b\n1,2\n3,4\n");
    edit(0, 0, "x");
    const rebased = workerReply({ type: "rebase" }, "rebased");
    expect(applyTextPatches("a,b\n1,2\n3,4\n", rebased.patches)).toBe("a,b\nx,2\n3,4\n");
    expect(callWorker({ type: "page", page: 1, pageSize: 10 }).find((m) => m.type === "pageResult")!.rows[0].cells).toEqual(["x", "2"]);
  });
});
