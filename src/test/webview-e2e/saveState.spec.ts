import { expect, test } from "@playwright/test";
import { awaitPosted, bootAndLoad, clearPosted, defaultViewState } from "./harness";
import { smallFixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///people.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
});

test("toggling a column's visibility posts saveState with the updated state", async ({ page }) => {
  await clearPosted(page);
  await page.locator("#columns-btn").click();
  await page.locator(".column-row", { hasText: "age" }).locator('input[type="checkbox"]').uncheck();

  const saved = await awaitPosted(page, "saveState");
  const state = saved.state as { columnVisibility: Record<string, boolean> };
  expect(state.columnVisibility.age).toBe(false);
});

test("sorting a column posts saveState with the new sort keys", async ({ page }) => {
  await clearPosted(page);
  await page.locator("th", { hasText: "age" }).click();

  const saved = await awaitPosted(page, "saveState");
  const state = saved.state as { sortKeys: Array<{ column: string; direction: string }> };
  expect(state.sortKeys).toEqual([{ column: "age", direction: "asc" }]);
});

test("toggling 'first row is header' posts saveState", async ({ page }) => {
  await clearPosted(page);
  await page.locator("#first-row-header").uncheck();

  const saved = await awaitPosted(page, "saveState");
  const state = saved.state as { firstRowIsHeader: boolean };
  expect(state.firstRowIsHeader).toBe(false);
});
