// Scale: 200k rows x 30 columns. Times first render (posting `load` to the
// table becoming visible), each interaction (sort/filter/page/separator),
// and the JS heap via the CDP Performance domain. Prints a timing table to
// the test output — this is a measurement spec, not a strict pass/fail
// benchmark, but sanity-bounds each step generously so a true hang/crash
// still fails the suite.

import { expect, test } from "@playwright/test";
import { bootShell, pushLoadText, defaultViewState } from "../harness";
import { trackConsoleErrors, wideFixtureText } from "./stressHelpers";

const ROWS = 200_000;
const COLS = 30;
const GENEROUS_BOUND_MS = 30_000;

test("200k rows x 30 columns: timing table for first render and each interaction, plus JS heap", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = trackConsoleErrors(page);
  const timings: Array<{ step: string; ms: number }> = [];

  await bootShell(page);
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");

  async function heapMB(): Promise<number> {
    const { metrics } = await client.send("Performance.getMetrics");
    const m = metrics.find((x) => x.name === "JSHeapUsedSize");
    return m ? m.value / (1024 * 1024) : -1;
  }

  const text = wideFixtureText(ROWS, COLS);

  const t0 = Date.now();
  await pushLoadText(page, {
    fileKey: "file:///scale.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 8,
  });
  await expect(page.locator("tr.data-row").first()).toBeVisible();
  const firstRenderMs = Date.now() - t0;
  timings.push({ step: "first render (load -> table visible)", ms: firstRenderMs });
  expect(firstRenderMs).toBeLessThan(GENEROUS_BOUND_MS);

  const heapAfterLoad = await heapMB();

  async function timeStep(step: string, action: () => Promise<void>): Promise<void> {
    const start = Date.now();
    await action();
    const ms = Date.now() - start;
    timings.push({ step, ms });
    expect(ms).toBeLessThan(GENEROUS_BOUND_MS);
  }

  await timeStep("sort by col_2 (header click, asc)", async () => {
    await page.locator("th", { hasText: "col_2" }).click();
    await expect(page.locator("th", { hasText: "col_2" }).locator(".sort-indicator")).toHaveText("▲");
  });

  await timeStep("filter: add rule, col_3 contains 'v1'", async () => {
    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator("select").nth(0).selectOption("col_3");
    await rule.locator("select").nth(1).selectOption("contains");
    await rule.locator('input[type="text"]').fill("v1");
    await expect(page.locator("#status-bar")).not.toHaveText(`Showing ${ROWS} of ${ROWS} rows`);
  });

  await timeStep("pagination: Next page", async () => {
    await page.locator("#pager-next-btn").click();
    await expect(page.locator("#pager-page-input")).toHaveValue("2");
  });

  await timeStep("separator: switch to Semicolon (collapses to 1 column)", async () => {
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
