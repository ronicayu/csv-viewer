// Longer values are never parsed: a synchronous JSON.parse of megabytes would block the thread.
export const JSON_PARSE_MAX_CHARS = 1024 * 1024;

export function tryParseJsonValue(value: string): unknown | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > JSON_PARSE_MAX_CHARS) return null;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function looksLikeJsonObjectOrArray(value: string): boolean {
  return tryParseJsonValue(value) !== null;
}

// Re-indents without JSON.parse so big integers, "1.10" and duplicate keys are shown as written.
export function formatJsonText(text: string): string {
  const src = text.trim();
  let out = "";
  let depth = 0;
  const newline = (): void => {
    out += "\n" + "  ".repeat(depth);
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (ch === "{" || ch === "[") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      const close = ch === "{" ? "}" : "]";
      if (src[j] === close) {
        out += ch + close;
        i = j;
      } else {
        out += ch;
        depth++;
        newline();
      }
    } else if (ch === "}" || ch === "]") {
      depth--;
      newline();
      out += ch;
    } else if (ch === ",") {
      out += ch;
      newline();
    } else if (ch === ":") {
      out += ": ";
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}
