import * as buffer from "buffer";

// WHATWG UTF-8: the same verdict as a fatal TextDecoder, without building the string.
export function isValidUtf8Js(bytes: Uint8Array): boolean {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let low = 0x80;
    let high = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) low = 0xa0;
      else if (b === 0xed) high = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) low = 0x90;
      else if (b === 0xf4) high = 0x8f;
    } else return false;
    if (i + need >= n) return false;
    const first = bytes[i + 1];
    if (first < low || first > high) return false;
    for (let k = 2; k <= need; k++) {
      const c = bytes[i + k];
      if (c < 0x80 || c > 0xbf) return false;
    }
    i += need + 1;
  }
  return true;
}

// Node's own check where the runtime has it (19.4+, 18.14+); VS Code 1.80's extension host runs an older Node.
export function isValidUtf8(bytes: Uint8Array): boolean {
  const native = (buffer as { isUtf8?: (input: Uint8Array) => boolean }).isUtf8;
  return typeof native === "function" ? native(bytes) : isValidUtf8Js(bytes);
}
