// No-op query skip: an edit to the filter panel that doesn't change which
// rules are *active* (per isRuleActive) — adding a fresh, still-empty
// rule, or picking its column/operator before it has a value — must never
// send a `query` to the worker. Only once the rule actually becomes
// active (or an already-active rule's semantics change) should a real
// query go out. This matters at scale: each real query re-filters (and,
// with an active sort, re-sorts) the whole dataset, so an intermediate
// step of configuring one rule used to pay that cost 3-4 times over for
// no reason — see runQuery/buildQueryKey in src/webview/main.ts.
//
// Observed via a test-only counter (`window.__workerQueryCount`,
// incremented once per `query` message actually posted to the worker),
// enabled by passing `testHooks: true` on the `load` message.

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
  expect(afterLoad).toBeGreaterThan(0); // the initial load itself queries once

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  // Debounced (150ms) — give each edit time to have fired if it were
  // going to.
  await page.waitForTimeout(250);
  const afterAddRule = await queryCount(page);
  expect(afterAddRule).toBe(afterLoad); // still inactive (no value) — no query sent

  await rule.locator('select[aria-label="Column"]').selectOption("col_2");
  await page.waitForTimeout(250);
  const afterColumn = await queryCount(page);
  expect(afterColumn).toBe(afterLoad); // still no value — still inactive, still no query

  await rule.locator('select[aria-label="Condition"]').selectOption("contains");
  await page.waitForTimeout(250);
  const afterOperator = await queryCount(page);
  expect(afterOperator).toBe(afterLoad); // "contains" needs a value too — still inactive

  // Now give it a value: the rule becomes active, so this — and only
  // this — must send exactly one real query.
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

  await rule.locator(".mode-select").selectOption("exclude"); // Keep -> Hide: changes the result
  await page.waitForTimeout(250);
  const afterToggle = await queryCount(page);
  expect(afterToggle).toBe(afterActive + 1);
});
