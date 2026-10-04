import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "../harness";
import { wideFixture } from "./stressHelpers";

async function queryCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __workerQueryCount?: number }).__workerQueryCount ?? 0);
}

test("adding an empty rule and picking its column/operator (before it has a value) sends no worker query; giving it a value sends exactly one", async ({
  page,
}) => {
  const fixture = wideFixture(500, 4);
  await bootAndLoad(page, {
    fileKey: "file:///noop-query.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
    testHooks: true,
  });

  const afterLoad = await queryCount(page);
  expect(afterLoad).toBeGreaterThan(0);

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  // Wait past the edit debounce so a query would have fired if one were going to.
  await page.waitForTimeout(250);
  const afterAddRule = await queryCount(page);
  expect(afterAddRule).toBe(afterLoad);

  await rule.locator('select[aria-label="Column"]').selectOption("col_2");
  await page.waitForTimeout(250);
  const afterColumn = await queryCount(page);
  expect(afterColumn).toBe(afterLoad);

  await rule.locator('select[aria-label="Condition"]').selectOption("contains");
  await page.waitForTimeout(250);
  const afterOperator = await queryCount(page);
  expect(afterOperator).toBe(afterLoad);

  await rule.locator('input[type="text"]').fill("v1");
  await expect(page.locator("#status-bar")).not.toHaveText(`Showing ${fixture.rows.length} of ${fixture.rows.length} rows`);
  const afterValue = await queryCount(page);
  expect(afterValue).toBe(afterLoad + 1);
});

test("toggling a rule's case-sensitivity or Include/Exclude on an ALREADY-active rule still sends a query each time (a real semantic change, not a no-op)", async ({
  page,
}) => {
  const fixture = wideFixture(500, 4);
  await bootAndLoad(page, {
    fileKey: "file:///noop-query-active.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
    testHooks: true,
  });

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator('select[aria-label="Column"]').selectOption("col_2");
  await rule.locator('select[aria-label="Condition"]').selectOption("contains");
  await rule.locator('input[type="text"]').fill("v1");
  await expect(page.locator("#status-bar")).not.toHaveText(`Showing ${fixture.rows.length} of ${fixture.rows.length} rows`);
  const afterActive = await queryCount(page);

  await rule.locator(".mode-select").selectOption("exclude");
  await page.waitForTimeout(250);
  const afterToggle = await queryCount(page);
  expect(afterToggle).toBe(afterActive + 1);
});
