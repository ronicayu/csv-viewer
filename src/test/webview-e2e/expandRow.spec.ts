import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "./harness";
import { smallFixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
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
  await expect(firstDetail.locator("dt", { hasText: "id" })).toHaveCount(0);

  await firstRow.click();
  await expect(firstDetail).toBeHidden();
});

test("the Expand/collapse toggle expands every row on the page, then collapses them, flipping its icon and label each time", async ({ page }) => {
  const toggle = page.locator("#expand-collapse-btn");
  await expect(toggle).toHaveAttribute("aria-label", "Expand all rows on this page");
  await expect(toggle.locator(".codicon-expand-all")).toHaveCount(1);

  await toggle.click();
  const details = page.locator("tr.detail-row");
  await expect(details).toHaveCount(smallFixture.rows.length);
  for (const detail of await details.all()) await expect(detail).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", "Collapse all rows on this page");
  await expect(toggle.locator(".codicon-collapse-all")).toHaveCount(1);

  await toggle.click();
  for (const detail of await details.all()) await expect(detail).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-label", "Expand all rows on this page");
  await expect(toggle.locator(".codicon-expand-all")).toHaveCount(1);
});

test("the toggle shows 'collapse' once every row on the page is already expanded (e.g. by expanding the last one by hand)", async ({ page }) => {
  const toggle = page.locator("#expand-collapse-btn");
  for (const row of await page.locator("tr.data-row").all()) await row.click();
  await expect(toggle).toHaveAttribute("aria-label", "Collapse all rows on this page");
});
