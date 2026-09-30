// Shared helpers for the adversarial "stress" suite. These specs load the
// same shipped bundle as the rest of src/test/webview-e2e via ../harness,
// but push weirder inputs (huge fixtures, hostile strings, rapid-fire
// interaction) and are expected to occasionally *find* bugs. A spec that
// finds one uses test.fail() with a comment describing the bug so the
// overall suite stays green; see e.g. weirdHeaders.spec.ts.

import type { Page } from "@playwright/test";

/**
 * Attach a console listener and return the live array of `console.error`
 * text collected so far. Call this right after bootShell/bootAndLoad(Text)
 * — messages logged before the listener is attached are missed, so callers
 * should attach before triggering the interaction under test.
 */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    // harness.ts already installs a pageerror listener that throws; this
    // one just records the message for specs that want to report it (the
    // throw still happens via the harness's own listener).
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

/** A payload containing the three required injection probes, as both a
 * header-safe and cell-safe string (no embedded newlines either way — CSV
 * text generation here is manual, not Papa.unparse, so we keep these free
 * of the delimiter/quote characters that would otherwise need escaping). */
export const XSS_IMG = "<img src=x onerror=window.__xssFired=(window.__xssFired||0)+1>";
export const XSS_SCRIPT = "<script>window.__xssFired=(window.__xssFired||0)+1</script>";
export const XSS_QUOTE_BREAKOUT = "\"><b>bold</b>";

/** Build raw CSV text directly (no Papa.unparse) from headers/rows, quoting
 * only fields that need it (contain the delimiter, a quote, or a newline).
 * Faster than Papa.unparse for the large scale fixtures and gives full
 * control over exactly which bytes hit the wire. */
export function toCsvText(headers: string[], rows: string[][], delimiter = ","): string {
  const quote = (field: string): string => {
    if (field.includes(delimiter) || field.includes('"') || field.includes("\n") || field.includes("\r")) {
      return `"${field.replace(/"/g, '""')}"`;
    }
    return field;
  };
  const lines = [headers.map(quote).join(delimiter)];
  for (const row of rows) lines.push(row.map(quote).join(delimiter));
  return lines.join("\n");
}

/** headers = col_1..col_n; each row is n simple numeric-ish strings, cheap
 * to generate for wide/tall scale fixtures. */
export function wideFixture(rowCount: number, colCount: number): { headers: string[]; rows: string[][] } {
  const headers = Array.from({ length: colCount }, (_, i) => `col_${i + 1}`);
  const rows: string[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: string[] = [];
    for (let c = 0; c < colCount; c++) row.push(c === 0 ? String(r) : `v${r}_${c}`);
    rows.push(row);
  }
  return { headers, rows };
}

/** Same shape as wideFixture but returns ready-to-send CSV text built with
 * plain string concatenation (fastest path, no per-cell quoting needed
 * since none of the generated values contain the delimiter/quote/newline). */
export function wideFixtureText(rowCount: number, colCount: number, delimiter = ","): string {
  const headers = Array.from({ length: colCount }, (_, i) => `col_${i + 1}`);
  const lines: string[] = [headers.join(delimiter)];
  for (let r = 0; r < rowCount; r++) {
    const cells: string[] = [];
    for (let c = 0; c < colCount; c++) cells.push(c === 0 ? String(r) : `v${r}_${c}`);
    lines.push(cells.join(delimiter));
  }
  return lines.join("\n");
}

export const SCREENSHOT_DIR = "test-results/stress-screens";
