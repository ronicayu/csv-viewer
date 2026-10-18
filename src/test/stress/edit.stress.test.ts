import { describe, expect, it } from "vitest";
import { spliceText } from "../../core/csvEdit";
import { splitRecordsToTable } from "../../core/recordSpans";
import { perfBoundMs } from "./perfEnv";

function makeCsv(rows: number, cols: number): string {
  const lines: string[] = new Array(rows + 1);
  lines[0] = Array.from({ length: cols }, (_, i) => `col${i}`).join(",");
  for (let i = 0; i < rows; i++) {
    const cells = new Array<string>(cols);
    for (let c = 0; c < cols; c++) {
      cells[c] = c === 0 ? String(i) : c === 1 ? (i % 7 === 0 ? "" : `"value, ${i % 1000}"`) : `col${c}-${(i * 13 + c) % 500}`;
    }
    lines[i + 1] = cells.join(",");
  }
  return lines.join("\n") + "\n";
}

describe("performance: record spans and splicing", () => {
  it("splitRecords over a 500k-row x 20-column file", () => {
    const text = makeCsv(500_000, 20);
    const start = performance.now();
    const table = splitRecordsToTable(text, { delimiter: ",", quotes: true });
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`splitRecords: 500k rows x 20 cols (${(text.length / 1e6).toFixed(0)} MB): ${ms.toFixed(1)}ms`);
    expect(table.length).toBe(500_001);
    expect(ms).toBeLessThan(perfBoundMs(1500, 15_000));
  }, 60000);

  it("spliceText of 10 edits into a ~100 MB text", () => {
    const text = makeCsv(600_000, 22);
    const table = splitRecordsToTable(text, { delimiter: ",", quotes: true });
    const records = Array.from({ length: 10 }, (_, i) => ({
      index: 1 + i * 50_000,
      fields: Array.from({ length: 22 }, (_, c) => `edited ${i}, ${c}`),
    }));
    const start = performance.now();
    const out = spliceText(text, table, records, ",", true);
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`spliceText: 10 edits into ${(text.length / 1e6).toFixed(0)} MB: ${ms.toFixed(1)}ms`);
    expect(out.length).not.toBe(text.length);
    expect(ms).toBeLessThan(perfBoundMs(2000, 20_000));
  }, 60000);
});
