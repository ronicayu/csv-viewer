import { expect, test, type Page } from "@playwright/test";
import { bootShell, defaultViewState } from "../harness";
import { trackConsoleErrors } from "./stressHelpers";
import type { ViewState } from "../../../core/types";

const ROWS = 200_000;
const COLS = 30;
const CI_SLACK = process.env.CI ? 2 : 1;
// Strict wall-clock bounds apply only when PERF_TESTS=1; a shared full-suite run gets generous ones.
const STRICT = process.env.PERF_TESTS === "1";
const FIRST_RENDER_BOUND_MS = STRICT ? 2_000 * CI_SLACK : 20_000;
const FILTER_BOUND_MS = STRICT ? 500 * CI_SLACK : 10_000;
const SORT_BOUND_MS = STRICT ? 500 * CI_SLACK : 10_000;
const GENEROUS_BOUND_MS = 30_000 * CI_SLACK;

// Generated in the page; tens of MB through Playwright's arguments would skew the timing.
async function pushGeneratedLoad(
  page: Page,
  opts: { fileKey: string; rowCount: number; colCount: number; state: ViewState; defaultTableColumns: number },
): Promise<void> {
  await page.evaluate((o) => {
    function wideFixtureText(rowCount: number, colCount: number, delimiter = ","): string {
      const headers: string[] = [];
      for (let i = 0; i < colCount; i++) headers.push(`col_${i + 1}`);
      const lines: string[] = [headers.join(delimiter)];
      for (let r = 0; r < rowCount; r++) {
        const cells: string[] = [];
        for (let c = 0; c < colCount; c++) cells.push(c === 0 ? String(r) : `v${r}_${c}`);
        lines.push(cells.join(delimiter));
      }
      return lines.join("\n");
    }
    const text = wideFixtureText(o.rowCount, o.colCount);
    window.postMessage(
      { type: "load", fileKey: o.fileKey, text, state: o.state, defaultTableColumns: o.defaultTableColumns, defaultDelimiter: "" },
      "*",
    );
  }, opts);
}

test("200k rows x 30 columns: timing table for first render and each interaction, plus JS heap", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = trackConsoleErrors(page);
  const timings: Array<{ step: string; ms: number }> = [];

  await bootShell(page);
  // Uses performance.memory: enabling CDP metrics slowed every timed step 2-3x.
  async function heapMB(): Promise<number> {
    const bytes = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? -1);
    return bytes < 0 ? -1 : bytes / (1024 * 1024);
  }

  const t0 = Date.now();
  await pushGeneratedLoad(page, {
    fileKey: "file:///scale.csv",
    rowCount: ROWS,
    colCount: COLS,
    state: defaultViewState(),
    defaultTableColumns: 8,
  });
  await expect(page.locator("tr.data-row").first()).toBeVisible();
  const firstRenderMs = Date.now() - t0;
  timings.push({ step: "first render (load -> table visible)", ms: firstRenderMs });
  expect(firstRenderMs).toBeLessThan(FIRST_RENDER_BOUND_MS);

  const heapAfterLoad = await heapMB();

  async function timeStep(step: string, bound: number, action: () => Promise<void>): Promise<void> {
    const start = Date.now();
    await action();
    const ms = Date.now() - start;
    timings.push({ step, ms });
    expect(ms).toBeLessThan(bound);
  }

  await timeStep("sort by col_2 (header click, asc)", SORT_BOUND_MS, async () => {
    await page.locator("th", { hasText: "col_2" }).click();
    await expect(page.locator("th", { hasText: "col_2" })).toHaveAttribute("aria-sort", "ascending");
  });

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator('select[aria-label="Column"]').selectOption("col_3");
  await rule.locator('select[aria-label="Condition"]').selectOption("contains");
  await timeStep("filter: col_3 contains 'v1' (type value -> result)", FILTER_BOUND_MS, async () => {
    await rule.locator('input[type="text"]').fill("v1");
    await expect(page.locator("#status-bar")).not.toHaveText(`Showing ${ROWS.toLocaleString()} of ${ROWS.toLocaleString()} rows`);
  });

  await timeStep("pagination: Next page", GENEROUS_BOUND_MS, async () => {
    await page.locator("#pager-next-btn").click();
    await expect(page.locator("#pager-page-input")).toHaveValue("2");
  });

  await timeStep("separator: switch to Semicolon (collapses to 1 column)", GENEROUS_BOUND_MS, async () => {
    await page.locator("#format-btn").click();
    await page.locator("#separator-select").selectOption(";");
    await expect(page.locator("th.sortable")).toHaveCount(1);
  });

  const heapAfterInteractions = await heapMB();
  timings.push({ step: "JS heap after first render (MB)", ms: Math.round(heapAfterLoad) });
  timings.push({ step: "JS heap after all interactions (MB)", ms: Math.round(heapAfterInteractions) });

  // eslint-disable-next-line no-console
  console.log("\n[stress] 200k x 30 timing table:");
  // eslint-disable-next-line no-console
  console.log(
    timings.map((t) => `  ${t.step.padEnd(55)} ${String(t.ms).padStart(8)}`).join("\n"),
  );

  expect(consoleErrors).toEqual([]);
});
