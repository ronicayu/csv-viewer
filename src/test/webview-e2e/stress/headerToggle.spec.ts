import { expect, test } from "@playwright/test";
import { bootAndLoadText, defaultViewState } from "../harness";
import { trackConsoleErrors } from "./stressHelpers";

test("toggling 'first row is header' off and on 10 times in a row never throws and always leaves a consistent table", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const text = "a,b,c\n1,2,3\n4,5,6\n7,8,9";
  await bootAndLoadText(page, {
    fileKey: "file:///toggle-stress.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await page.locator("#format-btn").click();
  const checkbox = page.locator("#first-row-header");
  for (let i = 0; i < 10; i++) {
    await checkbox.uncheck();
    await expect(page.locator("th", { hasText: "column_1" })).toHaveCount(1);
    await checkbox.check();
    await expect(page.locator("th.sortable")).toHaveCount(3);
    await expect(page.locator("th", { hasText: "column_1" })).toHaveCount(0);
  }
  expect(consoleErrors).toEqual([]);
});

test("a column-visibility customization survives toggling 'first row is header' off and back on, since the header names end up unchanged", async ({
  page,
}) => {
  const text = "a,b,c,d\n1,2,3,4\n5,6,7,8";
  await bootAndLoadText(page, {
    fileKey: "file:///toggle-visibility.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  await page.locator("#columns-btn").click();
  await page.locator(".column-row", { hasText: "b" }).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator("th", { hasText: "b" })).toHaveCount(0);

  await page.locator("#format-btn").click();
  await page.locator("#first-row-header").uncheck();
  await page.locator("#first-row-header").check();

  await expect(page.locator("th", { hasText: "b" })).toHaveCount(0);
});
