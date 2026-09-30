// Adversarial injection probes: a header and a cell containing
// `<img src=x onerror=...>`, `<script>...</script>`, and a quote-breakout
// `"><b>bold</b>` must never execute and must render as literal text
// everywhere the value can surface — table cell, header, detail view,
// columns popover list, sort-by dropdown, filter column dropdown, and the
// status bar (which never echoes cell content, checked here just for
// completeness).

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
  await loadEvilFixture(page, 3); // everything visible in the table

  // If either payload had executed, this flag would be set.
  const fired = await page.evaluate(() => (window as unknown as { __xssFired?: number }).__xssFired);
  expect(fired).toBeUndefined();
  // No real <img>/<script> element should exist anywhere in the DOM either
  // (textContent assignment can't create them, but assert the absence
  // directly rather than only inferring it from the flag).
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(page.locator("script", { hasText: "__xssFired" })).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("the evil header renders literally in the table head, columns popover, sort-by dropdown, and filter column dropdown", async ({
  page,
}) => {
  await loadEvilFixture(page, 3);

  // Table head.
  const th = page.locator("th", { hasText: "onerror" });
  await expect(th).toHaveCount(1);
  await expect(th).toHaveText(EVIL_HEADER, { useInnerText: false });

  // Columns popover.
  await page.locator("#columns-btn").click();
  const columnRow = page.locator(".column-row", { hasText: "onerror" });
  await expect(columnRow).toHaveCount(1);
  await expect(columnRow.locator("span")).toHaveText(EVIL_HEADER);
  await page.locator("#columns-btn").click(); // close

  // Sort-by dropdown (option text, not selected value, since jsdom-free
  // Playwright can read <option> textContent directly).
  const sortOption = page.locator("#sort-by-select option", { hasText: "onerror" });
  await expect(sortOption).toHaveCount(1);
  await expect(sortOption).toHaveText(EVIL_HEADER);

  // Filter column dropdown, inside a rule row.
  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const filterColumnOption = page.locator(".rule-row select").first().locator("option", { hasText: "onerror" });
  await expect(filterColumnOption).toHaveCount(1);
  await expect(filterColumnOption).toHaveText(EVIL_HEADER);
});

test("the evil cell renders literally in the table row and in the detail panel", async ({ page }) => {
  await loadEvilFixture(page, 1); // only "id" visible in the table -> evil column is detail-only

  const firstRow = page.locator("tr.data-row").first();
  await firstRow.click();
  const detail = page.locator("tr.detail-row").first();
  await expect(detail).toBeVisible();
  const dd = detail.locator("dd").first();
  await expect(dd).toHaveText(EVIL_CELL);
});

test("the evil cell renders literally as a table cell when its column is visible", async ({ page }) => {
  await loadEvilFixture(page, 3); // evil column visible in the table

  const td = page.locator("tr.data-row").first().locator("td").nth(2); // chevron, id, evil
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
  await expect(page.locator("#context-menu button")).toHaveText(["Filter: include this value", "Filter: exclude this value"]);

  const fired = await page.evaluate(() => (window as unknown as { __xssFired?: number }).__xssFired);
  expect(fired).toBeUndefined();
});

test("quick-adding a filter on the evil cell value still matches literally (equals, not as markup)", async ({ page }) => {
  await loadEvilFixture(page, 3);
  const td = page.locator("tr.data-row").first().locator("td").nth(2);
  await td.click({ button: "right" });
  await page.locator("#context-menu button", { hasText: "include this value" }).click();

  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 2 rows");
  const rule = page.locator(".rule-row").first();
  await expect(rule.locator('input[type="text"]')).toHaveValue(EVIL_CELL);
});
