import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "./harness";
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

async function firstColumnValues(page: import("@playwright/test").Page, column: string): Promise<string[]> {
  const colIndex = smallFixture.headers.indexOf(column);
  return page.locator("tr.data-row").evaluateAll((rows, ci) => rows.map((r) => r.children[ci + 1]?.textContent ?? ""), colIndex);
}

async function expectColumnValues(page: import("@playwright/test").Page, column: string, expected: string[]): Promise<void> {
  await expect.poll(() => firstColumnValues(page, column)).toEqual(expected);
}

test("clicking a header cycles asc -> desc -> none", async ({ page }) => {
  const ageHeader = page.locator("th", { hasText: "age" });

  await ageHeader.click();
  await expect(ageHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(ageHeader.locator(".codicon-arrow-up")).toHaveCount(1);
  await expectColumnValues(page, "age", ["25", "28", "30", "35", "40"]);

  await ageHeader.click();
  await expect(ageHeader).toHaveAttribute("aria-sort", "descending");
  await expect(ageHeader.locator(".codicon-arrow-down")).toHaveCount(1);
  await expectColumnValues(page, "age", ["40", "35", "30", "28", "25"]);

  await ageHeader.click();
  await expect(ageHeader).toHaveAttribute("aria-sort", "none");
  await expect(ageHeader.locator(".sort-indicator")).toHaveCount(0);
  await expectColumnValues(page, "id", ["1", "2", "3", "4", "5"]);
});

test("shift+click adds a secondary sort key with a priority indicator", async ({ page }) => {
  const cityHeader = page.locator("th", { hasText: "city" });
  const ageHeader = page.locator("th", { hasText: "age" });

  await cityHeader.click();
  await ageHeader.click({ modifiers: ["Shift"] });

  await expect(cityHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(ageHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(cityHeader.locator(".sort-priority")).toHaveText("1");
  await expect(ageHeader.locator(".sort-priority")).toHaveText("2");
  await expect(cityHeader.locator(".visually-hidden")).toHaveText("sorted ascending, priority 1");
  await expect(ageHeader.locator(".visually-hidden")).toHaveText("sorted ascending, priority 2");

  await expectColumnValues(page, "name", ["Bob", "Charlie", "Alice", "Eve", "Dana"]);

  await page.locator("#sort-btn").click();
  const keyRows = page.locator(".sort-key-row");
  await expect(keyRows).toHaveCount(2);
  await expect(keyRows.nth(0).locator(".sort-key-column")).toHaveText("city");
  await expect(keyRows.nth(0).locator(".sort-key-priority")).toHaveText("1");
  await expect(keyRows.nth(1).locator(".sort-key-column")).toHaveText("age");
  await expect(keyRows.nth(1).locator(".sort-key-priority")).toHaveText("2");
});

test("Sort button shows a count badge once keys exist, and none while closed with no sort", async ({ page }) => {
  await expect(page.locator("#sort-btn")).toHaveText("Sort");
  await page.locator("th", { hasText: "age" }).click();
  await expect(page.locator("#sort-btn")).toHaveText("Sort • 1");
  await page.locator("th", { hasText: "city" }).click({ modifiers: ["Shift"] });
  await expect(page.locator("#sort-btn")).toHaveText("Sort • 2");
});

test("the Sort popover's direction toggle flips a key's direction and stays in sync with the header", async ({ page }) => {
  await page.locator("th", { hasText: "age" }).click();
  await expectColumnValues(page, "age", ["25", "28", "30", "35", "40"]);

  await page.locator("#sort-btn").click();
  const keyRow = page.locator(".sort-key-row").first();
  await expect(keyRow.locator(".sort-key-dir-btn")).toHaveAttribute("aria-label", "Sort ascending");
  await keyRow.locator(".sort-key-dir-btn").click();

  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "descending");
  await expect(keyRow.locator(".sort-key-dir-btn")).toHaveAttribute("aria-label", "Sort descending");
  await expectColumnValues(page, "age", ["40", "35", "30", "28", "25"]);
});

test("the Sort popover's remove button removes a key and keeps the rest", async ({ page }) => {
  await page.locator("th", { hasText: "city" }).click();
  await page.locator("th", { hasText: "age" }).click({ modifiers: ["Shift"] });

  await page.locator("#sort-btn").click();
  await expect(page.locator(".sort-key-row")).toHaveCount(2);
  await page.locator(".sort-key-row").first().locator(".sort-key-remove-btn").click();

  await expect(page.locator(".sort-key-row")).toHaveCount(1);
  await expect(page.locator(".sort-key-row").first().locator(".sort-key-column")).toHaveText("age");
  await expect(page.locator("th", { hasText: "city" })).toHaveAttribute("aria-sort", "none");
  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("th", { hasText: "age" }).locator(".sort-priority")).toHaveCount(0);
});

test("Clear sort removes every key and only shows once at least one key exists", async ({ page }) => {
  await page.locator("#sort-btn").click();
  await expect(page.locator("#sort-clear-btn")).toBeHidden();
  await page.keyboard.press("Escape");

  await page.locator("th", { hasText: "age" }).click();
  await page.locator("#sort-btn").click();
  await expect(page.locator("#sort-clear-btn")).toBeVisible();
  await page.locator("#sort-clear-btn").click();

  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "none");
  await expect(page.locator("#sort-btn")).toHaveText("Sort");
  await expect(page.locator("#sort-clear-btn")).toBeHidden();
});

test("'Add sort column' lists every column not already a key, adds it ascending, and follows header clicks", async ({ page }) => {
  await page.locator("th", { hasText: "city" }).click();
  await page.locator("#sort-btn").click();

  const addSelect = page.locator("#sort-add-select");
  await expect(addSelect.locator("option", { hasText: "city" })).toHaveCount(0);
  await expect(addSelect.locator("option", { hasText: "age" })).toHaveCount(1);

  await addSelect.selectOption("age");
  await expect(page.locator(".sort-key-row")).toHaveCount(2);
  await expect(page.locator("th", { hasText: "age" })).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("th", { hasText: "age" }).locator(".sort-priority")).toHaveText("2");
});

test("'Add sort column' includes columns that are in row details (no header to click), and sorting by one works", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///detail-sort.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });
  await expect(page.locator("th", { hasText: "city" })).toHaveCount(0);

  await page.locator("#sort-btn").click();
  const addSelect = page.locator("#sort-add-select");
  await expect(addSelect.locator("option", { hasText: "city" })).toHaveCount(1);
  await addSelect.selectOption("city");

  await expect(page.locator("#sort-btn")).toHaveText("Sort • 1");
  await expect.poll(() => firstColumnValues(page, "age")).toEqual(["25", "35", "30", "40", "28"]);
});
