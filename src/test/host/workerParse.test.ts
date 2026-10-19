import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyTextPatches, spliceByteReplacements } from "../../core/csvEdit";
import { parseCsv } from "../../core/csvParse";
import { bootHost, callWorker, workerMessages, workerReply } from "./harness";

const OPTIONS = { firstRowIsHeader: true, quotes: true };
const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

// A worker with its parse cut into slices of `sliceRecords` records, so even a small file is still parsing when the next message arrives.
const initSliced = (text: string, sliceRecords: number, extra: Record<string, unknown> = {}) =>
  callWorker({ type: "init", text, options: OPTIONS, tuning: { sliceRecords }, ...extra }).find((m) => m.type === "initResult")!;

async function untilParseDone(from: number, requestId?: number): Promise<any> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const done = workerMessages().slice(from).find((m) => m.type === "parseDone" && (requestId === undefined || m.requestId === requestId));
    if (done) return done;
    if (Date.now() > deadline) throw new Error("parseDone never came");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => `${i},v${i}`).join("\n");

describe("worker: progressive parse", () => {
  it("answers with the first slice and the first page, then reports the rest", async () => {
    await bootHost();
    const text = `id,v\n${rowsOf(40)}\n`;
    const from = workerMessages().length;
    const result = initSliced(text, 10, { firstPage: { page: 1, pageSize: 5 } });
    expect(result).toMatchObject({ parsing: true, spansOk: undefined, totalRows: 9, headers: ["id", "v"] });
    expect(result.firstPage.rows.map((r: { id: number }) => r.id)).toEqual([0, 1, 2, 3, 4]);
    expect(result.firstPage.rows[2].cells).toEqual(["2", "v2"]);

    const done = await untilParseDone(from, result.requestId);
    expect(done).toMatchObject({ totalRows: 40, spansOk: true, rebuilt: false });
    // The first slice held fewer rows than the 200 the profiles sample, so they are sent again.
    expect(done.columnProfiles).toHaveLength(2);
    expect(workerReply({ type: "page", page: 1, pageSize: 100 }, "pageResult").rows).toHaveLength(40);
  });

  it("gives no first page when the rows so far do not fill it, and none for a file parsed in one slice", async () => {
    await bootHost();
    expect(initSliced(`id,v\n${rowsOf(40)}\n`, 3, { firstPage: { page: 1, pageSize: 5 } }).firstPage).toBeUndefined();
    const small = initSliced(`id,v\n${rowsOf(3)}\n`, 100, { firstPage: { page: 1, pageSize: 2 } });
    expect(small.firstPage).toBeUndefined();
    expect(small).toMatchObject({ parsing: undefined, spansOk: true, totalRows: 3 });
  });

  it("an edit sent before parseDone finishes the parse first and lands on the right record", async () => {
    await bootHost();
    const text = `id,v\n${rowsOf(40)}\n`;
    const from = workerMessages().length;
    initSliced(text, 4);
    const out = callWorker({ type: "editCell", rowId: 30, columnIndex: 1, value: "edited" });
    expect(out.map((m) => m.type)).toEqual(["parseDone", "editResult"]);
    expect(out[0]).toMatchObject({ totalRows: 40, spansOk: true });
    expect(out[1].change.record.originalText).toBe("30,v30");
    expect(out[1].change.recordIndex).toBe(31);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workerMessages().slice(from).filter((m) => m.type === "parseDone")).toHaveLength(1);
  });

  it("a query, a distinct, setCells and a rebase before parseDone are answered over the whole table", async () => {
    await bootHost();
    const text = `id,v\n${rowsOf(40)}\n`;
    initSliced(text, 4);
    const query = callWorker({ type: "query", quickSearch: "v3", filterRules: [], sortKeys: [] });
    expect(query.map((m) => m.type)).toEqual(["parseDone", "queryStarted", "filterDone", "queryResult"]);
    expect(query[3].filteredCount).toBe(11);

    initSliced(text, 4);
    const distinct = callWorker({ type: "distinct", column: "id" });
    expect(distinct.map((m) => m.type)).toEqual(["parseDone", "distinctResult"]);
    expect(distinct[1].values).toHaveLength(40);

    initSliced(text, 4);
    const cells = callWorker({ type: "setCells", cells: [{ rowId: 35, columnIndex: 1, value: "x" }] });
    expect(cells.map((m) => m.type)).toEqual(["parseDone", "setCellsDone"]);

    initSliced(text, 4);
    expect(callWorker({ type: "rebase" }).map((m) => m.type)).toEqual(["parseDone", "rebased"]);
  });

  it("a new init mid-parse leaves no message of the old parse behind", async () => {
    await bootHost();
    const from = workerMessages().length;
    const first = initSliced(`id,v\n${rowsOf(40)}\n`, 2);
    const second = initSliced(`a,b,c\n${Array.from({ length: 30 }, (_, i) => `${i},x,y`).join("\n")}\n`, 2);
    await untilParseDone(from, second.requestId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = workerMessages().slice(from).filter((m) => m.type === "parseDone");
    expect(done.map((m) => m.requestId)).toEqual([second.requestId]);
    expect(first.requestId).not.toBe(second.requestId);
    expect(workerReply({ type: "page", page: 1, pageSize: 100 }, "pageResult").rows).toHaveLength(30);
  });

  it("a ragged file's headers and profiles are sent again when a later row is wider", async () => {
    await bootHost();
    const text = `a,b\n${rowsOf(6)}\n6,v6,extra,more\n`;
    const from = workerMessages().length;
    const result = initSliced(text, 3);
    expect(result.headers).toEqual(["a", "b"]);
    const done = await untilParseDone(from, result.requestId);
    expect(done.headers).toEqual(["a", "b", "column_3", "column_4"]);
    expect(done.columnProfiles).toHaveLength(4);
    const page = workerReply({ type: "page", page: 1, pageSize: 100 }, "pageResult");
    expect(page.rows[0].cells).toEqual(["0", "v0", "", ""]);
    expect(page.rows[6].cells).toEqual(["6", "v6", "extra", "more"]);
  });

  it("reparse re-parses the text the worker holds under new options", async () => {
    await bootHost();
    const text = "a;b\n1;2\n3;4\n";
    callWorker({ type: "init", bytes: encode(text), options: OPTIONS });
    const again = callWorker({ type: "reparse", options: { ...OPTIONS, delimiter: "," } }).find((m) => m.type === "initResult")!;
    const direct = parseCsv(text, { ...OPTIONS, delimiter: "," });
    expect(again.headers).toEqual(direct.headers);
    expect(again.detectedDelimiter).toBe(",");
    expect(workerReply({ type: "page", page: 1, pageSize: 10 }, "pageResult").rows.map((r: { cells: string[] }) => r.cells)).toEqual(direct.rows);
    const header = callWorker({ type: "reparse", options: { ...OPTIONS, firstRowIsHeader: false } }).find((m) => m.type === "initResult")!;
    expect(header.totalRows).toBe(3);
  });

  it("hands the bytes back and decodes them like a non-fatal TextDecoder", async () => {
    await bootHost();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62, 0x0a, 0x63, 0xff, 0x2c, 0x64, 0x0a]);
    const buffer = bytes.buffer.slice(0) as ArrayBuffer;
    const result = callWorker({ type: "init", bytes: buffer, options: OPTIONS }).find((m) => m.type === "initResult")!;
    expect(result.bytes).toBe(buffer);
    expect(result.headers).toEqual(["a", "b"]);
    expect(workerReply({ type: "page", page: 1, pageSize: 10 }, "pageResult").rows[0].cells).toEqual(["c�", "d"]);
  });
});

describe("worker: byte patches mirror the text patches", () => {
  const ALPHABET = ["a", "b", "1", ",", ";", '"', " ", "\n", "\r\n", "é", "😀", "€", "\t", "﻿"];
  const textArb = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 40 }).map((c) => c.join(""));
  const valueArb = fc.array(fc.constantFrom("a", ",", '"', " ", "\n", "é", "😀", "€", ""), { maxLength: 6 }).map((c) => c.join(""));

  it("decode(spliceByteReplacements(bytes, bytePatches)) equals applyTextPatches(text, patches), and the length stays known (property)", async () => {
    await bootHost();
    let rebases = 0;
    fc.assert(
      fc.property(textArb, fc.array(fc.tuple(fc.nat(), fc.nat({ max: 3 }), valueArb), { minLength: 1, maxLength: 4 }), (text, picks) => {
        if (text.startsWith("﻿﻿")) return;
        const bytes = new TextEncoder().encode(text);
        const init = callWorker({ type: "init", bytes: bytes.buffer.slice(0), options: OPTIONS }).find((m) => m.type === "initResult")!;
        if (init.spansOk === false || init.totalRows === 0) return;
        const written: { recordIndex: number; fields: string[] }[] = [];
        for (const [pick, column, value] of picks) {
          const result = workerReply({ type: "editCell", rowId: pick % init.totalRows, columnIndex: column % init.headers.length, value }, "editResult");
          if (result.ok && result.change) written.push({ recordIndex: result.change.recordIndex, fields: [] });
        }
        if (written.length === 0) return;
        const rebased = workerReply({ type: "rebase" }, "rebased");
        rebases++;
        const spliced = spliceByteReplacements(bytes, rebased.bytePatches);
        const patched = applyTextPatches(text, rebased.patches);
        expect(decode(spliced)).toBe(patched);
        // The worker still holds the patched text, and its byte offsets stay exact on the next edit.
        const next = callWorker({ type: "editCell", rowId: 0, columnIndex: 0, value: "next" }).find((m) => m.type === "editResult");
        if (next?.ok && next.change) {
          expect(new TextEncoder().encode(patched).length).toBe(spliced.length);
          expect(next.change.record.byteStart).toBe(new TextEncoder().encode(patched.slice(0, next.change.record.charStart)).length);
        }
      }),
      { numRuns: 1500 },
    );
    expect(rebases).toBeGreaterThan(50);
  });
});
