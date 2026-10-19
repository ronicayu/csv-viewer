function endsWithDelimiterPrefix(field: string, delimiter: string): boolean {
  for (let k = 1; k < delimiter.length; k++) {
    if (field.endsWith(delimiter.slice(0, k))) return true;
  }
  return false;
}

export function needsQuotes(field: string, delimiter: string): boolean {
  if (field === "") return false;
  if (field.includes(delimiter) || field.includes('"') || field.includes("\n") || field.includes("\r")) return true;
  const first = field.charCodeAt(0);
  const last = field.charCodeAt(field.length - 1);
  if (first === 32 || first === 9 || last === 32 || last === 9) return true;
  // "a|" + "||" would read back as "a" + "|||" split at the first "||".
  return delimiter.length > 1 && endsWithDelimiterPrefix(field, delimiter);
}

// With quoting off nothing can be escaped, so only a separator or line break makes a value unwritable.
export function serializeField(field: string, delimiter: string, quotes: boolean): string | null {
  if (!quotes) {
    return field.includes(delimiter) || field.includes("\n") || field.includes("\r") ? null : field;
  }
  return needsQuotes(field, delimiter) ? `"${field.replace(/"/g, '""')}"` : field;
}

// No terminator. Fields must not contain "\r" (parsed values never do).
export function serializeRecord(fields: readonly string[], delimiter: string, quotes: boolean): string {
  const parts: string[] = [];
  for (const field of fields) {
    const written = serializeField(field, delimiter, quotes);
    if (written === null) throw new Error("serializeRecord: a field cannot be written with quoting off");
    parts.push(written);
  }
  return parts.join(delimiter);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// False for a string with an unpaired surrogate, which UTF-8 cannot hold (TextEncoder writes U+FFFD for it). String.prototype.isWellFormed is
// newer than the Chromium of the oldest supported VS Code, so it is used only when there.
export function isWellFormedUtf16(s: string): boolean {
  const native = (s as { isWellFormed?: () => boolean }).isWellFormed;
  return typeof native === "function" ? native.call(s) : !LONE_SURROGATE.test(s);
}

// Exact for well-formed UTF-16; a lone surrogate counts 3, like TextEncoder.
export function utf8Length(s: string, from = 0, to = s.length): number {
  let bytes = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
