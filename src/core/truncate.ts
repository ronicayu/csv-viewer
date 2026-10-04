// Rendering a multi-megabyte cell in full trips VS Code's unresponsive-webview watchdog.
export const TABLE_CELL_MAX_CHARS = 500;

export const DETAIL_MAX_CHARS = 10_000;

export const DETAIL_WARN_CHARS = 1024 * 1024;

export interface Truncated {
  text: string;
  truncated: boolean;
  fullLength: number;
}

function truncateTo(value: string, maxChars: number): Truncated {
  if (value.length <= maxChars) return { text: value, truncated: false, fullLength: value.length };
  return { text: value.slice(0, maxChars) + "…", truncated: true, fullLength: value.length };
}

export function truncateForTable(value: string): Truncated {
  return truncateTo(value, TABLE_CELL_MAX_CHARS);
}

export function truncateForDetail(value: string): Truncated {
  return truncateTo(value, DETAIL_MAX_CHARS);
}
