// Shared "does this CSV cell value look like JSON" detection, used both by
// the worker's column profiling (src/core/columns.ts — jsonShare, which
// feeds the smart default column split) and the detail panel's
// pretty-print/Raw toggle (src/webview/main.ts). Pure module, no vscode/DOM.
//
// A value counts as JSON only if, after trimming, it starts with `{` or
// `[` AND JSON.parse succeeds AND the parsed result is actually an object
// or array (JSON.parse("1") or JSON.parse('"x"') would otherwise succeed
// for inputs that don't start with { or [ anyway, but this also excludes
// the degenerate case of a bare `null` surviving the start-character
// check if it somehow began with one of those bytes — it can't, this is
// just defense in depth).

/** Values longer than this are never even attempted — parsing untrusted
 * multi-megabyte text synchronously could block the worker (profiling) or
 * the main thread (detail panel pretty-print) for a value nobody is even
 * looking at yet. */
export const JSON_PARSE_MAX_CHARS = 1024 * 1024; // 1 MB

/**
 * Trims `value` and attempts to parse it as JSON, returning the parsed
 * object/array, or null if it doesn't look like JSON (doesn't start with
 * `{`/`[`), fails to parse, parses to a non-object (e.g. a bare number),
 * or exceeds JSON_PARSE_MAX_CHARS.
 */
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

/** True when `value` would be rendered as pretty-printed JSON. */
export function looksLikeJsonObjectOrArray(value: string): boolean {
  return tryParseJsonValue(value) !== null;
}

/**
 * Re-indents JSON text (2 spaces) without parsing its values, so every
 * literal is shown exactly as written. JSON.stringify(JSON.parse(text))
 * would silently change the data: integers above 2^53 lose digits, `1.10`
 * becomes `1.1`, and a duplicate key disappears. Call this only on text
 * that already parsed as JSON (see tryParseJsonValue); it relies on the
 * text being well formed.
 */
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
      // Copy the whole string literal verbatim, honoring escapes.
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (ch === "{" || ch === "[") {
      // Keep empty containers on one line: {} and [].
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
      out += ch; // number, true, false, null: copied character by character
    }
  }
  return out;
}
