import Papa from "papaparse";
import { expect, test } from "@playwright/test";
import { awaitPosted, bootAndLoadText, defaultViewState } from "./harness";
import { largeFixture, smallFixture } from "./fixtures";

function textWithDelimiter(headers: string[], rows: string[][], delimiter: string): string {
  return Papa.unparse({ fields: headers, data: rows }, { delimiter });
}

async function openFormatPopover(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#format-btn").click();
  await expect(page.locator("#format-popover")).toBeVisible();
}

test("separator dropdown shows the detected 'Auto (;)' for a semicolon fixture", async ({ page }) => {
  const text = textWithDelimiter(smallFixture.headers, smallFixture.rows, ";");
  await bootAndLoadText(page, {
    fileKey: "file:///semi.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  await openFormatPopover(page);
  await expect(page.locator("#separator-select")).toHaveValue("");
  await expect(page.locator("#separator-select option:checked")).toHaveText("Auto (;)");
  await expect(page.locator("#table-head th.sortable")).toHaveCount(4);
});

test("switching the separator to Comma re-splits the columns and resets to page 1", async ({ page }) => {
  const fixture = largeFixture(150);
  const text = textWithDelimiter(fixture.headers, fixture.rows, ";");
  await bootAndLoadText(page, {
    fileKey: "file:///semi-big.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 5,
  });
  await expect(page.locator("#table-head th.sortable")).toHaveCount(5);

  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");

  await openFormatPopover(page);
  await page.locator("#separator-select").selectOption(",");
  await expect(page.locator("#table-head th.sortable")).toHaveCount(1);
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("Custom… reveals an input, and a custom || delimiter re-parses correctly", async ({ page }) => {
  const text = textWithDelimiter(smallFixture.headers, smallFixture.rows, "||");
  // Generous defaultTableColumns so none of the real headers start hidden after the re-parse.
  await bootAndLoadText(page, {
    fileKey: "file:///pipe2.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 8,
  });

  await openFormatPopover(page);
  await page.locator("#separator-select").selectOption("custom");
  await expect(page.locator("#separator-custom")).toBeVisible();
  await page.locator("#separator-custom").fill("||");

  await expect(page.locator("#table-head th.sortable")).toHaveCount(4);
  await expect(page.locator("#table-head th", { hasText: "age" })).toHaveCount(1);
  await expect(page.locator("tr.data-row").first()).toContainText("Alice");

  const saved = await awaitPosted(page, "saveState");
  expect((saved.state as { delimiter: string }).delimiter).toBe("||");
});

test("an empty custom value falls back to Auto", async ({ page }) => {
  const text = textWithDelimiter(smallFixture.headers, smallFixture.rows, ";");
  await bootAndLoadText(page, {
    fileKey: "file:///semi-custom.csv",
    text,
    state: defaultViewState({ delimiter: "||" }),
    defaultTableColumns: 4,
  });
  await openFormatPopover(page);
  await expect(page.locator("#separator-select")).toHaveValue("custom");
  await expect(page.locator("#separator-custom")).toBeVisible();

  await page.locator("#separator-custom").fill("");

  await expect(page.locator("#separator-select")).toHaveValue("");
  const saved = await awaitPosted(page, "saveState");
  expect((saved.state as { delimiter: string }).delimiter).toBe("");
});

test("a load with state.delimiter set honors it, taking precedence over auto-detection", async ({ page }) => {
  // Commas inside fields make comma a plausible auto-detected delimiter; the stored '|' must still win.
  const text = "name|amount\nWidget, Inc|1,000\nGadget, LLC|2,000";
  await bootAndLoadText(page, {
    fileKey: "file:///forced-pipe.csv",
    text,
    state: defaultViewState({ delimiter: "|" }),
    defaultTableColumns: 2,
  });

  await expect(page.locator("#table-head th.sortable")).toHaveCount(2);
  await expect(page.locator("tr.data-row").first()).toContainText("Widget, Inc");
  await openFormatPopover(page);
  await expect(page.locator("#separator-select")).toHaveValue("|");
});

test("defaultDelimiter '\\t' is used when the stored state has none", async ({ page }) => {
  const text = "a\tb\tc\n1\t2\t3\n4\t5\t6";
  await bootAndLoadText(page, {
    fileKey: "file:///tabs.tsv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
    defaultDelimiter: "\t",
  });

  await expect(page.locator("#table-head th.sortable")).toHaveCount(3);
  await openFormatPopover(page);
  await expect(page.locator("#separator-select")).toHaveValue("");
  await expect(page.locator("#separator-select option:checked")).toHaveText("Auto (Tab)");
});

test("a stray mid-field quote renders as 3 cells end to end, not a swallowed rest-of-file", async ({ page }) => {
  const text = 'name,size,type\nWidget,5" screen,TV\nGadget,10" screen,Monitor';
  await bootAndLoadText(page, {
    fileKey: "file:///stray-quote.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await expect(page.locator("#table-head th.sortable")).toHaveCount(3);
  await expect(page.locator("tr.data-row")).toHaveCount(2);

  const firstRowCells = page.locator("tr.data-row").first().locator("td:not(.chevron-col)");
  await expect(firstRowCells).toHaveCount(3);
  await expect(firstRowCells.nth(1)).toHaveText('5" screen');
  await expect(firstRowCells.nth(2)).toHaveText("TV");
});

test("the File format button's tooltip states the current format", async ({ page }) => {
  const text = textWithDelimiter(smallFixture.headers, smallFixture.rows, ";");
  await bootAndLoadText(page, {
    fileKey: "file:///tooltip.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });
  await expect(page.locator("#format-btn")).toHaveAttribute("title", "File format: semicolon, first row is header, quoted fields on");

  await openFormatPopover(page);
  await page.locator("#first-row-header").uncheck();
  await expect(page.locator("#format-btn")).toHaveAttribute("title", "File format: semicolon, no header row, quoted fields on");

  await page.locator("#quotes-checkbox").uncheck();
  await expect(page.locator("#format-btn")).toHaveAttribute("title", "File format: semicolon, no header row, quoted fields off");
});
