import { describe, expect, it } from "vitest";
import { openSession } from "./harness";

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
