import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "./harness";
import { smallFixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///people.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4, // everything visible in the table to start
  });
});

test("unchecking a column in the Columns popover moves it from the table to the detail panel", async ({ page }) => {
  await expect(page.locator("#table-head th", { hasText: "age" })).toHaveCount(1);

  await page.locator("#columns-btn").click();
  await expect(page.locator("#columns-popover")).toBeVisible();

  const ageCheckbox = page.locator(".column-row", { hasText: "age" }).locator('input[type="checkbox"]');
  await expect(ageCheckbox).toBeChecked();
  await ageCheckbox.uncheck();

  await expect(page.locator("#table-head th", { hasText: "age" })).toHaveCount(0);

  // Close the popover first — a click on a row while a popover is open
  // closes the popover instead of also toggling the row underneath it
  // (see docs/reviews/ux-review.md §3, "click-through" behind an open
  // popover).
  await page.keyboard.press("Escape");
  await expect(page.locator("#columns-popover")).toBeHidden();

  // Expanding a row now shows "age" in its detail panel.
  await page.locator("tr.data-row").first().click();
  const detail = page.locator("tr.detail-row").first();
  await expect(detail.locator("dt", { hasText: "age" })).toBeVisible();
});

test("Show all / Hide all toggle every column at once", async ({ page }) => {
  await page.locator("#columns-btn").click();
  await page.locator("#columns-hide-all").click();
  await expect(page.locator("#table-head th.sortable")).toHaveCount(0);

  await page.locator("#columns-show-all").click();
  await expect(page.locator("#table-head th.sortable")).toHaveCount(smallFixture.headers.length);
});

test("the columns search box filters the checkbox list", async ({ page }) => {
  await page.locator("#columns-btn").click();
  await page.locator("#columns-search").fill("age");
  await expect(page.locator("#columns-list .column-row")).toHaveCount(1);
  await expect(page.locator("#columns-list .column-row")).toContainText("age");
});
