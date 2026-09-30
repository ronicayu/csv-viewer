// Cell-value truncation for rendering only. Pure module, no vscode/DOM —
// the worker and the main thread both keep/return FULL cell values;
// truncation happens only at the point of rendering into the DOM (table
// cell vs. detail-view), so quick-add (which needs the full value) and any
// other consumer of the underlying data are never affected. See
// docs/spec.md ("Huge cells").

/** Table cells show at most this many characters, then "…". A 15 MB
 * single-line cell used to be rendered in full and trip VS Code's
 * unresponsive-webview watchdog. */
export const TABLE_CELL_MAX_CHARS = 500;

/** The detail view (expanded row) shows at most this many characters up
 * front, with a "Show all (N characters)" button to expand in place. */
export const DETAIL_MAX_CHARS = 10_000;

/** Above this size, the detail view's "Show all" button warns in its
 * title that expanding a huge value may be slow. */
export const DETAIL_WARN_CHARS = 1024 * 1024;

export interface Truncated {
  /** The (possibly truncated) text to render. */
  text: string;
  /** Whether `text` is shorter than the original value. */
  truncated: boolean;
  /** The original value's full length. */
  fullLength: number;
}

function truncateTo(value: string, maxChars: number): Truncated {
  if (value.length <= maxChars) return { text: value, truncated: false, fullLength: value.length };
  return { text: value.slice(0, maxChars) + "…", truncated: true, fullLength: value.length };
}

/** Truncation for a table cell: first 500 characters plus "…". */
export function truncateForTable(value: string): Truncated {
  return truncateTo(value, TABLE_CELL_MAX_CHARS);
}

/** Truncation for the detail view: first 10,000 characters plus "…" (the
 * caller renders a "Show all (N characters)" button alongside). */
export function truncateForDetail(value: string): Truncated {
  return truncateTo(value, DETAIL_MAX_CHARS);
}
