import { expect, test } from "@playwright/test";
import { awaitPosted, bootAndLoad, clearPosted, defaultViewState, pushLoad } from "./harness";
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

test("the invalid-regex message appears while typing and clears once the pattern is valid", async ({ page }) => {
  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();

  const rule = page.locator(".rule-row").first();
  await rule.locator("select").nth(1).selectOption("regex");
  await rule.locator('input[type="text"]').fill("(bad");
  await expect(rule.locator(".rule-error-text")).toBeVisible();

  await rule.locator('input[type="text"]').fill("(ok)");
  await expect(rule.locator(".rule-error-text")).toBeHidden();
});

test("a rule added after reloading persisted rules gets a distinct id", async ({ page }) => {
  const persisted = {
    id: "rule-1",
    column: "city",
    operator: "equals" as const,
    value: "LA",
    mode: "exclude" as const,
    caseSensitive: false,
    enabled: true,
  };
  await pushLoad(page, {
    fileKey: "file:///people.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState({ filterRules: [persisted] }),
    defaultTableColumns: 4,
  });
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 5 rows");

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  await expect(page.locator(".rule-row")).toHaveCount(2);

  // Removing the new rule must leave the persisted one in place.
  await page.locator(".rule-row").nth(1).locator(".remove-rule-btn").click();
  await expect(page.locator(".rule-row")).toHaveCount(1);
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 5 rows");
});
