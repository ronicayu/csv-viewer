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

test("adding an exclude rule reduces the row count and updates the status bar", async ({ page }) => {
  await expect(page.locator("#status-bar")).toHaveText("Showing 5 of 5 rows");

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();

  const rule = page.locator(".rule-row").first();
  await rule.locator("select").nth(0).selectOption("city"); // column
  await rule.locator("select").nth(1).selectOption("equals"); // operator
  await rule.locator('input[type="text"]').fill("LA");
  await rule.locator(".mode-toggle").click(); // Include -> Exclude

  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 5 rows");
});

test("an invalid regex rule is shown in an error state and has no effect", async ({ page }) => {
  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();

  const rule = page.locator(".rule-row").first();
  await rule.locator("select").nth(1).selectOption("regex");
  await rule.locator('input[type="text"]').fill("(unterminated");

  await expect(rule).toHaveClass(/rule-error/);
  await expect(page.locator("#status-bar")).toHaveText("Showing 5 of 5 rows");
});

test("quick search filters across all columns and debounces, then posts saveState", async ({ page }) => {
  await clearPosted(page);
  await page.locator("#quick-search").fill("la");

  await expect(page.locator("#status-bar")).toHaveText("Showing 2 of 5 rows");
  const saved = await awaitPosted(page, "saveState");
  expect((saved.state as { quickSearch: string }).quickSearch).toBe("la");
});
