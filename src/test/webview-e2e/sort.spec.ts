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

/** Sorting now runs in a Web Worker (see docs/spec.md) and re-renders
 * asynchronously once it answers, so a `.click()` resolving doesn't mean
 * the new row order has painted yet — poll instead of reading the DOM
 * exactly once right after the click. Same exact expected order as
 * before; only how the assertion waits changed. */
async function expectColumnValues(page: import("@playwright/test").Page, column: string, expected: string[]): Promise<void> {
  await expect.poll(() => firstColumnValues(page, column)).toEqual(expected);
}

test("clicking a header cycles asc -> desc -> none", async ({ page }) => {
  const ageHeader = page.locator("th", { hasText: "age" });

  await ageHeader.click();
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▲");
  await expectColumnValues(page, "age", ["25", "28", "30", "35", "40"]);

  await ageHeader.click();
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▼");
  await expectColumnValues(page, "age", ["40", "35", "30", "28", "25"]);

  await ageHeader.click();
  await expect(ageHeader.locator(".sort-indicator")).toHaveCount(0);
  await expectColumnValues(page, "id", ["1", "2", "3", "4", "5"]);
});

test("shift+click adds a secondary sort key with a priority indicator", async ({ page }) => {
  const cityHeader = page.locator("th", { hasText: "city" });
  const ageHeader = page.locator("th", { hasText: "age" });

  await cityHeader.click(); // primary key
  await ageHeader.click({ modifiers: ["Shift"] }); // secondary key

  await expect(cityHeader.locator(".sort-indicator")).toHaveText("▲1");
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▲2");

  // city asc, age asc as tiebreak: LA(25,35) < NYC(30,40) < SF(28)
  await expectColumnValues(page, "name", ["Bob", "Charlie", "Alice", "Eve", "Dana"]);
});

test("Sort by… dropdown sorts a column and the direction button flips it", async ({ page }) => {
  await page.locator("#sort-by-select").selectOption("age");
  await expectColumnValues(page, "age", ["25", "28", "30", "35", "40"]);

  await page.locator("#sort-dir-btn").click();
  await expect(page.locator("#sort-dir-btn")).toHaveText("▼");
  await expectColumnValues(page, "age", ["40", "35", "30", "28", "25"]);
});

test("Sort by… dropdown follows header clicks", async ({ page }) => {
  await page.locator("th", { hasText: "city" }).click();
  await expect(page.locator("#sort-by-select")).toHaveValue("city");
  await expect(page.locator("#sort-dir-btn")).toBeVisible();
});
