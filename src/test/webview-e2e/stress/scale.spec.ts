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
const IN_PAGE_FIRST_RENDER_BOUND_MS = STRICT ? 400 * CI_SLACK : 20_000;
const FILTER_BOUND_MS = STRICT ? 500 * CI_SLACK : 10_000;
const SORT_BOUND_MS = STRICT ? 500 * CI_SLACK : 10_000;
const NEXT_PAGE_BOUND_MS = STRICT ? 300 * CI_SLACK : 30_000 * CI_SLACK;
const SEPARATOR_BOUND_MS = STRICT ? 500 * CI_SLACK : 30_000 * CI_SLACK;

// Generated in the page and kept on window, so the timed step is only the post; tens of MB through Playwright's arguments would skew the timing.
async function generateLoadText(page: Page, opts: { rowCount: number; colCount: number }): Promise<void> {
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
    (window as unknown as { __scaleText: string }).__scaleText = wideFixtureText(o.rowCount, o.colCount);
  }, opts);
}

// As VS Code delivers a file: bytes, encoded before the clock starts.
async function encodeLoadText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __scaleText?: string; __scaleBytes?: ArrayBuffer };
    w.__scaleBytes = new TextEncoder().encode(w.__scaleText).buffer as ArrayBuffer;
    delete w.__scaleText;
  });
}

async function postGeneratedLoad(page: Page, opts: { fileKey: string; state: ViewState; defaultTableColumns: number; asBytes: boolean }): Promise<void> {
  await page.evaluate((o) => {
    const w = window as unknown as { __scaleText?: string; __scaleBytes?: ArrayBuffer };
    const message = { type: "load", fileKey: o.fileKey, state: o.state, defaultTableColumns: o.defaultTableColumns, defaultDelimiter: "", testHooks: true };
    if (o.asBytes) {
      const bytes = w.__scaleBytes!;
      window.postMessage({ ...message, bytes }, "*", [bytes]);
      delete w.__scaleBytes;
    } else {
      window.postMessage({ ...message, text: w.__scaleText }, "*");
      // The post has cloned it; keeping 60 MB reachable would inflate the heap figures.
      delete w.__scaleText;
    }
  }, opts);
}

// The webview marks parseDone when the parse outlasts the first page.
async function parseDoneMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const at = (name: string): number | undefined => performance.getEntriesByName(name).slice(-1)[0]?.startTime;
    const done = at("csv:parse-done");
    return done === undefined ? -1 : done - at("csv:load")!;
  });
}

// The webview marks the load's arrival and its first render when testHooks is on.
async function inPageFirstRenderMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const at = (name: string): number => performance.getEntriesByName(name).slice(-1)[0].startTime;
    return at("csv:first-render") - at("csv:load");
  });
}

test("200k rows x 30 columns: timing table for first render and each interaction, plus JS heap", async ({ page }) => {
  await runScale(page, false);
});

// The path VS Code takes: the file crosses as bytes and the worker decodes it.
test("200k rows x 30 columns, posted as bytes: timing table for first render and each interaction, plus JS heap", async ({ page }) => {
  await runScale(page, true);
});

async function runScale(page: Page, asBytes: boolean): Promise<void> {
  test.setTimeout(120_000);
  const consoleErrors = trackConsoleErrors(page);
  const timings: Array<{ step: string; ms: number }> = [];

  await bootShell(page);
  // Uses performance.memory: enabling CDP metrics slowed every timed step 2-3x.
  async function heapMB(): Promise<number> {
    const bytes = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? -1);
    return bytes < 0 ? -1 : bytes / (1024 * 1024);
  }

  await generateLoadText(page, { rowCount: ROWS, colCount: COLS });
  if (asBytes) await encodeLoadText(page);
  const t0 = Date.now();
  await postGeneratedLoad(page, { fileKey: "file:///scale.csv", state: defaultViewState(), defaultTableColumns: 8, asBytes });
  await expect(page.locator("tr.data-row").first()).toBeVisible();
  const firstRenderMs = Date.now() - t0;
  const inPageMs = Math.round(await inPageFirstRenderMs(page));
  timings.push({ step: "first render (post load -> table visible)", ms: firstRenderMs });
  timings.push({ step: "first render (in-page, load -> first row)", ms: inPageMs });
  expect(firstRenderMs).toBeLessThan(FIRST_RENDER_BOUND_MS);
  expect(inPageMs).toBeLessThan(IN_PAGE_FIRST_RENDER_BOUND_MS);

  // The first page is up before the row count is known; the interactions below are timed on a parsed file.
  await expect(page.locator("#status-bar")).toHaveText(`Showing ${ROWS.toLocaleString()} of ${ROWS.toLocaleString()} rows`);
  timings.push({ step: "parseDone (in-page, load -> every row parsed)", ms: Math.round(await parseDoneMs(page)) });

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

  await timeStep("pagination: Next page", NEXT_PAGE_BOUND_MS, async () => {
    await page.locator("#pager-next-btn").click();
    await expect(page.locator("#pager-page-input")).toHaveValue("2");
  });

  await timeStep("separator: switch to Semicolon (collapses to 1 column)", SEPARATOR_BOUND_MS, async () => {
    await page.locator("#format-btn").click();
    await page.locator("#separator-select").selectOption(";");
    await expect(page.locator("th.sortable")).toHaveCount(1);
  });

  const heapAfterInteractions = await heapMB();
  timings.push({ step: "JS heap after first render (MB)", ms: Math.round(heapAfterLoad) });
  timings.push({ step: "JS heap after all interactions (MB)", ms: Math.round(heapAfterInteractions) });

  // eslint-disable-next-line no-console
  console.log(`\n[stress] 200k x 30 timing table${asBytes ? " (bytes)" : ""}:`);
  // eslint-disable-next-line no-console
  console.log(
    timings.map((t) => `  ${t.step.padEnd(55)} ${String(t.ms).padStart(8)}`).join("\n"),
  );

  expect(consoleErrors).toEqual([]);
}
