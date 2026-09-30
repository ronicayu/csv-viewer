import { expect, test } from "@playwright/test";
import { awaitPosted, bootAndLoad, clearPosted, defaultViewState, pushLoad } from "./harness";
import { largeFixture } from "./fixtures";

// 250 rows @ the default page size of 100 -> 3 pages (100, 100, 50). Enough
// room to move off page 1 and check what resets the page vs. what doesn't.
const fixture = largeFixture(250);

test.beforeEach(async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///medium.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 5,
  });
});

test("quick search resets the page to 1", async ({ page }) => {
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await page.locator("#quick-search").fill("Person 1");
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("adding a filter rule resets the page to 1", async ({ page }) => {
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("sorting a column resets the page to 1", async ({ page }) => {
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await page.locator("th", { hasText: "age" }).click();
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("toggling a column's visibility keeps the current page", async ({ page }) => {
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await page.locator("#columns-btn").click();
  await page.locator(".column-row", { hasText: "age" }).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");
});

test("nav buttons are disabled at the first and last page", async ({ page }) => {
  await expect(page.locator("#pager-first-btn")).toBeDisabled();
  await expect(page.locator("#pager-prev-btn")).toBeDisabled();
  await expect(page.locator("#pager-next-btn")).toBeEnabled();
  await expect(page.locator("#pager-last-btn")).toBeEnabled();

  await page.locator("#pager-last-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("3");
  await expect(page.locator("#pager-next-btn")).toBeDisabled();
  await expect(page.locator("#pager-last-btn")).toBeDisabled();
  await expect(page.locator("#pager-first-btn")).toBeEnabled();
  await expect(page.locator("#pager-prev-btn")).toBeEnabled();
});

test("zero matching rows shows a message and disables every nav button", async ({ page }) => {
  await page.locator("#quick-search").fill("no-such-row-xyz");
  await expect(page.locator("#pager-row-range")).toHaveText("No matching rows");
  await expect(page.locator("#pager-first-btn")).toBeDisabled();
  await expect(page.locator("#pager-prev-btn")).toBeDisabled();
  await expect(page.locator("#pager-next-btn")).toBeDisabled();
  await expect(page.locator("#pager-last-btn")).toBeDisabled();
});

test("Alt+ArrowRight / Alt+ArrowLeft change pages", async ({ page }) => {
  await page.locator("#pager-row-range").click(); // move focus out of any input
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("Alt+ArrowRight is ignored while focus is in a form control", async ({ page }) => {
  await page.locator("#quick-search").click();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("changing the page size posts saveState with the new pageSize", async ({ page }) => {
  await clearPosted(page);
  await page.locator("#pager-page-size-select").selectOption("500");

  const saved = await awaitPosted(page, "saveState");
  expect((saved.state as { pageSize: number }).pageSize).toBe(500);
});

test("loading with state.pageSize = 50 shows 50 rows per page", async ({ page }) => {
  await pushLoad(page, {
    fileKey: "file:///medium-50.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState({ pageSize: 50 }),
    defaultTableColumns: 5,
  });
  await expect(page.locator("tr.data-row")).toHaveCount(50);
  await expect(page.locator("#pager-page-count")).toHaveText("5");
});

test("a reload `load` for the same fileKey keeps the page, clamped to the new page count", async ({ page }) => {
  await page.locator("#pager-last-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("3"); // last page of 250 rows

  // Same fileKey, but now only 120 rows (2 pages at size 100) -> page 3 no
  // longer exists, so this must clamp down to page 2 rather than reset to 1.
  const smaller = largeFixture(120);
  await pushLoad(page, {
    fileKey: "file:///medium.csv",
    headers: smaller.headers,
    rows: smaller.rows,
    state: defaultViewState(),
    defaultTableColumns: 5,
  });
  await expect(page.locator("#pager-page-input")).toHaveValue("2");
  await expect(page.locator("tr.data-row")).toHaveCount(20);
});

test("a `load` for a different fileKey resets to page 1", async ({ page }) => {
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await pushLoad(page, {
    fileKey: "file:///other.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 5,
  });
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});
