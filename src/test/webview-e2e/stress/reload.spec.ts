import { expect, test } from "@playwright/test";
import { bootAndLoad, defaultViewState, pushLoad } from "../harness";
import { trackConsoleErrors, wideFixture } from "./stressHelpers";

test("a same-fileKey reload with fewer rows and a renamed column, while filters/sort/expanded-row/page-2/open-popover all exist, reconciles cleanly", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const fixture = wideFixture(250, 5);
  await bootAndLoad(page, {
    fileKey: "file:///reload-target.csv",
    headers: fixture.headers,
    rows: fixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 5,
  });

  await page.locator("th", { hasText: "col_3" }).click();
  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator('select[aria-label="Column"]').selectOption("col_2");
  await rule.locator('select[aria-label="Condition"]').selectOption("contains");
  await rule.locator('input[type="text"]').fill("v0_1");
  const modeSelect = rule.locator(".mode-select");
  await modeSelect.selectOption("exclude");
  await expect(page.locator("#status-bar")).toHaveText("Showing 249 of 250 rows");

  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");
  await page.locator("tr.data-row").first().click();
  await expect(page.locator("tr.detail-row").first()).toBeVisible();
  await page.locator("#columns-btn").click();
  await expect(page.locator("#columns-popover")).toBeVisible();

  const smaller = wideFixture(20, 5);
  smaller.headers[1] = "renamed_col";
  await pushLoad(page, {
    fileKey: "file:///reload-target.csv",
    headers: smaller.headers,
    rows: smaller.rows,
    state: defaultViewState(),
    defaultTableColumns: 5,
  });

  await expect(page.locator("#pager-page-input")).toHaveValue("1");
  await expect(page.locator("tr.data-row")).toHaveCount(20);

  await expect(page.locator("th", { hasText: "renamed_col" })).toHaveCount(1);

  await expect(page.locator("tr.detail-row:visible")).toHaveCount(0);

  await expect(page.locator("#columns-popover")).toBeVisible();
  await expect(page.locator(".column-row", { hasText: "renamed_col" })).toHaveCount(1);

  expect(consoleErrors).toEqual([]);
});

test("two `load` messages for the same fileKey posted back-to-back (without awaiting either's async onLoad) settle deterministically on the second message, with no console errors", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const fixtureA = wideFixture(300, 4);
  const fixtureB = wideFixture(15, 4);
  fixtureB.headers[2] = "col_3_renamed";

  await bootAndLoad(page, {
    fileKey: "file:///race.csv",
    headers: wideFixture(5, 4).headers,
    rows: wideFixture(5, 4).rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  await Promise.all([
    pushLoad(page, {
      fileKey: "file:///race.csv",
      headers: fixtureA.headers,
      rows: fixtureA.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    }),
    pushLoad(page, {
      fileKey: "file:///race.csv",
      headers: fixtureB.headers,
      rows: fixtureB.rows,
      state: defaultViewState(),
      defaultTableColumns: 4,
    }),
  ]);

  await expect(page.locator("tr.data-row")).toHaveCount(15);
  await expect(page.locator("th", { hasText: "col_3_renamed" })).toHaveCount(1);
  await expect(page.locator("#status-bar")).toHaveText("Showing 15 of 15 rows");
  expect(consoleErrors).toEqual([]);
});
