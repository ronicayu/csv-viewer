import { expect, test } from "@playwright/test";
import { bootAndLoadText, defaultViewState } from "../harness";
import { XSS_IMG, XSS_QUOTE_BREAKOUT, XSS_SCRIPT, toCsvText, trackConsoleErrors } from "./stressHelpers";

const EVIL_HEADER = `h${XSS_IMG}`;
const EVIL_CELL = `${XSS_SCRIPT}${XSS_QUOTE_BREAKOUT}`;

async function loadEvilFixture(page: import("@playwright/test").Page, defaultTableColumns: number): Promise<void> {
  const headers = ["id", EVIL_HEADER, "note"];
  const rows = [
    ["1", EVIL_CELL, "normal"],
    ["2", "plain", "also normal"],
  ];
  const text = toCsvText(headers, rows);
  await bootAndLoadText(page, {
    fileKey: "file:///evil.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns,
  });
}

test("neither the evil header nor the evil cell ever executes", async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  await loadEvilFixture(page, 3);

  const fired = await page.evaluate(() => (window as unknown as { __xssFired?: number }).__xssFired);
  expect(fired).toBeUndefined();
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(page.locator("script", { hasText: "__xssFired" })).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("the evil header renders literally in the table head, columns popover, sort popover's add-select, and filter column dropdown", async ({
  page,
}) => {
  await loadEvilFixture(page, 3);

  const th = page.locator("th", { hasText: "onerror" });
  await expect(th).toHaveCount(1);
  await expect(th).toHaveText(EVIL_HEADER, { useInnerText: false });

  await page.locator("#columns-btn").click();
  const columnRow = page.locator(".column-row", { hasText: "onerror" });
  await expect(columnRow).toHaveCount(1);
  await expect(columnRow.locator("span")).toHaveText(EVIL_HEADER);
  await page.locator("#columns-btn").click();

  await page.locator("#sort-btn").click();
  const sortOption = page.locator("#sort-add-select option", { hasText: "onerror" });
  await expect(sortOption).toHaveCount(1);
  await expect(sortOption).toHaveText(EVIL_HEADER);

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const filterColumnOption = page.locator('.rule-row select[aria-label="Column"]').first().locator("option", { hasText: "onerror" });
  await expect(filterColumnOption).toHaveCount(1);
  await expect(filterColumnOption).toHaveText(EVIL_HEADER);
});

test("the evil cell renders literally in the table row and in the detail panel", async ({ page }) => {
  await loadEvilFixture(page, 1);

  const firstRow = page.locator("tr.data-row").first();
  await firstRow.click();
  const detail = page.locator("tr.detail-row").first();
  await expect(detail).toBeVisible();
  await expect(detail.locator("dd").first().locator(".detail-value-text")).toHaveText(EVIL_CELL);
});

test("the evil cell renders literally as a table cell when its column is visible", async ({ page }) => {
  await loadEvilFixture(page, 3);

  const td = page.locator("tr.data-row").first().locator("td").nth(2);
  await expect(td).toHaveText(EVIL_CELL);
});

test("right-clicking the evil cell opens the quick-add context menu without executing anything, and the menu text stays fixed (never echoes the raw value)", async ({
  page,
}) => {
  const fired0 = await page.evaluate(() => (window as unknown as { __xssFired?: number }).__xssFired);
  expect(fired0).toBeUndefined();
  await loadEvilFixture(page, 3);

  const td = page.locator("tr.data-row").first().locator("td").nth(2);
  await td.click({ button: "right" });
  await expect(page.locator("#context-menu")).toBeVisible();
  const escapedHeader = EVIL_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(page.locator("#context-menu button")).toHaveText([
    "Copy Value",
    new RegExp(`^Show only rows where ${escapedHeader} = "`),
    new RegExp(`^Hide rows where ${escapedHeader} = "`),
    new RegExp(`^Filter ${escapedHeader} by Values…$`),
    "Copy Row as CSV",
    "Copy Row as JSON",
  ]);

  const fired = await page.evaluate(() => (window as unknown as { __xssFired?: number }).__xssFired);
  expect(fired).toBeUndefined();
});

test("quick-adding a filter on the evil cell value still matches literally (equals, not as markup)", async ({ page }) => {
  await loadEvilFixture(page, 3);
  const td = page.locator("tr.data-row").first().locator("td").nth(2);
  await td.click({ button: "right" });
  await page.locator("#context-menu button", { hasText: /^Show only rows where/ }).click();

  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 2 rows");
  const rule = page.locator(".rule-row").first();
  await expect(rule.locator('input[type="text"]')).toHaveValue(EVIL_CELL);
});
