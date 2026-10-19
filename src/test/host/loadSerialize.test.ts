import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chunking } from "../../extension";
import { openSession, tick } from "./harness";

// The replacer of VS Code's serializeWebviewMessage (extHostWebviewMessaging.ts; the same in release/1.80 and in main). It runs inside
// JSON.stringify, so a value's own toJSON has already been applied when the replacer sees it, and typed arrays are recognised by constructor name.
const TYPED = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"];

function serializeWebviewMessage(message: unknown): { json: string; buffers: ArrayBuffer[] } {
  const buffers: ArrayBuffer[] = [];
  const add = (buffer: ArrayBuffer): number => {
    let index = buffers.indexOf(buffer);
    if (index < 0) {
      index = buffers.length;
      buffers.push(buffer);
    }
    return index;
  };
  const json = JSON.stringify(message, (_key, value) => {
    if (value instanceof ArrayBuffer) return { $$vscode_array_buffer_reference$$: true, index: add(value) };
    if (ArrayBuffer.isView(value) && TYPED.includes(value.constructor.name)) {
      return { $$vscode_array_buffer_reference$$: true, index: add(value.buffer as ArrayBuffer), view: { type: value.constructor.name, byteLength: value.byteLength, byteOffset: value.byteOffset } };
    }
    return value;
  });
  return { json, buffers };
}

// What the renderer's deserializeWebviewMessage rebuilds from the attachments.
function deserialize(json: string, buffers: ArrayBuffer[]): any {
  return JSON.parse(json, (_key, value) => {
    if (value && value.$$vscode_array_buffer_reference$$) {
      const buffer = buffers[value.index];
      return value.view ? new Uint8Array(buffer, value.view.byteOffset, value.view.byteLength) : buffer;
    }
    return value;
  });
}

describe("the load message as VS Code ships it", () => {
  it("carries the file as one binary attachment with its offset and length, not as JSON", async () => {
    const original = "id,name\r\n1,é\r\n2,😀\r\n";
    const s = await openSession("/h/serialize.csv", original);
    const { json, buffers } = serializeWebviewMessage(s.of("load")[0]);
    expect(json).not.toContain('"Buffer"');
    expect(json.length).toBeLessThan(2000);
    expect(buffers).toHaveLength(1);
    const wire = JSON.parse(json).bytes;
    expect(wire.view).toMatchObject({ type: "Uint8Array", byteLength: new TextEncoder().encode(original).length });
    expect(wire.view.byteOffset).toBeGreaterThan(0);

    const received = deserialize(json, buffers).bytes as Uint8Array;
    expect(ArrayBuffer.isView(received)).toBe(true);
    expect(new TextDecoder().decode(received)).toBe(original);
    s.dispose();
  });

  it("no other message the host sends carries bytes", async () => {
    const s = await openSession("/h/serialize2.csv", "a,b\n1,2\n");
    for (const message of s.messages) {
      if (message.type === "load") continue;
      expect(serializeWebviewMessage(message).buffers).toHaveLength(0);
    }
    s.dispose();
  });
});

let counter = 0;

async function withChunking<T>(thresholdBytes: number, chunkBytes: number, run: () => Promise<T>): Promise<T> {
  const saved = { ...chunking };
  Object.assign(chunking, { thresholdBytes, chunkBytes });
  try {
    return await run();
  } finally {
    Object.assign(chunking, saved);
  }
}

describe("a chunked load as VS Code ships it", () => {
  const PIECES = ["a", "b", ",", "\n", "\r\n", '"', " ", "é", "€", "😀", "\u0000", "\ufeff", "日本"];
  const fileArb = fc.array(fc.constantFrom(...PIECES), { maxLength: 40 }).map((p) => new TextEncoder().encode(p.join("")));

  it("sends a header without bytes and chunks that are one exact-size attachment each, which reassemble to the file (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fileArb, fc.integer({ min: 1, max: 13 }), fc.constantFrom("zero", "below", "exact", "above", "half"), async (file, chunkBytes, where) => {
        const threshold = { zero: 0, below: file.length - 1, exact: file.length, above: file.length + 1, half: file.length >> 1 }[where];
        await withChunking(threshold, chunkBytes, async () => {
          const s = await openSession(`/h/chunk${++counter}.csv`, file);
          await tick(5);
          const shouldChunk = file.length > threshold;
          const loads = s.messages.filter((m) => m.type === "load");
          expect(loads).toHaveLength(1);
          if (!shouldChunk) {
            expect(serializeWebviewMessage(loads[0]).buffers).toHaveLength(1);
            expect(s.messages.some((m) => m.type === "loadChunk")).toBe(false);
          } else {
            const header = serializeWebviewMessage(loads[0]);
            expect(header.buffers).toHaveLength(0);
            expect(JSON.parse(header.json)).toMatchObject({ chunked: true, byteLength: file.length });
            const chunks = s.messages.filter((m) => m.type === "loadChunk");
            expect(chunks).toHaveLength(Math.ceil(file.length / chunkBytes));
            const assembled = new Uint8Array(file.length);
            let next = 0;
            for (const chunk of chunks) {
              const wire = serializeWebviewMessage(chunk);
              // One attachment, exactly the chunk: never the buffer the file sits in.
              expect(wire.buffers).toHaveLength(1);
              expect(wire.buffers[0].byteLength).toBeLessThanOrEqual(chunkBytes);
              const received = deserialize(wire.json, wire.buffers).bytes as Uint8Array;
              expect(received.byteLength).toBe(wire.buffers[0].byteLength);
              expect(JSON.parse(wire.json).offset).toBe(next);
              assembled.set(received, next);
              next += received.byteLength;
            }
            expect(next).toBe(file.length);
            expect(Array.from(assembled)).toEqual(Array.from(file));
          }
          // The webview model that assembled the chunks decoded the same text.
          expect(s.text).toBe(new TextDecoder("utf-8", { ignoreBOM: true }).decode(file));
          s.dispose();
        });
      }),
      { numRuns: 300 },
    );
  });

  it("covers the sizes that sit on a boundary: empty, threshold -1/exact/+1, whole multiples of the chunk", async () => {
    const chunkBytes = 8;
    for (const size of [0, 1, 7, 8, 9, 15, 16, 17, 64]) {
      await withChunking(16, chunkBytes, async () => {
        const text = "é".repeat(Math.floor(size / 2)) + "a".repeat(size % 2);
        const s = await openSession(`/h/chunkb${++counter}.csv`, text);
        await tick(5);
        const chunks = s.messages.filter((m) => m.type === "loadChunk");
        expect(chunks).toHaveLength(size > 16 ? Math.ceil(size / chunkBytes) : 0);
        expect(s.text).toBe(text);
        s.dispose();
      });
    }
  });

  it("a newer load replaces a load whose chunks are still going out; the chunk already in flight is ignored", async () => {
    await withChunking(8, 8, async () => {
      const original = "id,name\n" + Array.from({ length: 20 }, (_, i) => `${i},row${i}`).join("\n") + "\n";
      const s = await openSession(`/h/chunkn${++counter}.csv`, original, { deferReady: true });
      let release!: () => void;
      s.chunkGate = new Promise<void>((resolve) => (release = resolve));
      await s.ready();
      s.send({ type: "resync" });
      await tick(5);
      release();
      s.chunkGate = null;
      await tick(20);
      const headers = s.messages.filter((m) => m.type === "load") as { loadId: number }[];
      expect(headers).toHaveLength(2);
      const [first, second] = headers.map((h) => h.loadId);
      const chunks = s.messages.filter((m) => m.type === "loadChunk") as { loadId: number }[];
      expect(chunks.filter((c) => c.loadId === first).length).toBeLessThanOrEqual(1);
      expect(chunks.filter((c) => c.loadId === second).length).toBe(Math.ceil(new TextEncoder().encode(original).length / 8));
      expect(s.text).toBe(original);
      expect(s.received.filter((m) => m.type === "synced")).toHaveLength(1);
      s.dispose();
    });
  });

  it("a save while the chunks are still going out neither waits for the webview nor asks it to flush", async () => {
    await withChunking(8, 8, async () => {
      const original = "id,name\n" + Array.from({ length: 20 }, (_, i) => `${i},row${i}`).join("\n") + "\n";
      const s = await openSession(`/h/chunks${++counter}.csv`, original, { deferReady: true });
      s.chunkGate = new Promise<void>(() => undefined);
      await s.ready();
      const started = Date.now();
      await s.save();
      expect(Date.now() - started).toBeLessThan(400);
      expect(s.messages.some((m) => m.type === "flushEdits")).toBe(false);
      s.dispose();
    });
  });
});
