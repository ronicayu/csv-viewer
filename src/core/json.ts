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
