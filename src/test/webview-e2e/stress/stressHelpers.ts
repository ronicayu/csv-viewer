import type { Page } from "@playwright/test";

export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    // The harness's own pageerror listener does the throwing; this one only records the message.
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

export const XSS_IMG = "<img src=x onerror=window.__xssFired=(window.__xssFired||0)+1>";
export const XSS_SCRIPT = "<script>window.__xssFired=(window.__xssFired||0)+1</script>";
export const XSS_QUOTE_BREAKOUT = "\"><b>bold</b>";

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
