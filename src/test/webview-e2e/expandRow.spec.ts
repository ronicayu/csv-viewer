import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "./harness";
import { smallFixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
  // Only the first 2 columns (id, name) are in the table; age and city are
  // detail-only from the start.
  await bootAndLoad(page, {
    fileKey: "file:///people.csv",
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 2,
  });
});

test("clicking a row expands it and shows the detail-only fields", async ({ page }) => {
  const firstRow = page.locator("tr.data-row").first();
  const firstDetail = page.locator("tr.detail-row").first();
  await expect(firstDetail).toBeHidden();

  await firstRow.click();
  await expect(firstDetail).toBeVisible();
  await expect(firstDetail.locator("dt", { hasText: "age" })).toBeVisible();
  await expect(firstDetail.locator("dd", { hasText: "30" })).toBeVisible();
  await expect(firstDetail.locator("dt", { hasText: "city" })).toBeVisible();
  // "id" and "name" are already visible in the table, so they should not
  // be duplicated into the detail panel.
  await expect(firstDetail.locator("dt", { hasText: "id" })).toHaveCount(0);

  await firstRow.click();
  await expect(firstDetail).toBeHidden();
});

test("Expand page / Collapse page toggle every visible row's detail panel", async ({ page }) => {
  await page.locator("#expand-all-btn").click();
  const details = page.locator("tr.detail-row");
  await expect(details).toHaveCount(smallFixture.rows.length);
  for (const detail of await details.all()) await expect(detail).toBeVisible();

  await page.locator("#collapse-all-btn").click();
  for (const detail of await details.all()) await expect(detail).toBeHidden();
});
