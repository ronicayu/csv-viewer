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

test("clicking a header cycles asc -> desc -> none", async ({ page }) => {
  const ageHeader = page.locator("th", { hasText: "age" });

  await ageHeader.click();
  expect(await firstColumnValues(page, "age")).toEqual(["25", "28", "30", "35", "40"]);
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▲");

  await ageHeader.click();
  expect(await firstColumnValues(page, "age")).toEqual(["40", "35", "30", "28", "25"]);
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▼");

  await ageHeader.click();
  await expect(ageHeader.locator(".sort-indicator")).toHaveCount(0);
  expect(await firstColumnValues(page, "id")).toEqual(["1", "2", "3", "4", "5"]);
});

test("shift+click adds a secondary sort key with a priority indicator", async ({ page }) => {
  const cityHeader = page.locator("th", { hasText: "city" });
  const ageHeader = page.locator("th", { hasText: "age" });

  await cityHeader.click(); // primary key
  await ageHeader.click({ modifiers: ["Shift"] }); // secondary key

  await expect(cityHeader.locator(".sort-indicator")).toHaveText("▲1");
  await expect(ageHeader.locator(".sort-indicator")).toHaveText("▲2");

  // city asc, age asc as tiebreak: LA(25,35) < NYC(30,40) < SF(28)
  expect(await firstColumnValues(page, "name")).toEqual(["Bob", "Charlie", "Alice", "Eve", "Dana"]);
});
