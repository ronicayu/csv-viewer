// Separator feature: the toolbar "Separator" dropdown (Auto/Comma/
// Semicolon/Tab/Pipe/Custom…), its precedence rules (stored per-file choice
// > host defaultDelimiter > real auto-detect), and the stray-quote parsing
// regression Papa Parse fixes, exercised end to end against the built
// webview bundle.

import Papa from "papaparse";
import { expect, test } from "@playwright/test";
import { awaitPosted, bootAndLoadText, defaultViewState } from "./harness";
import { largeFixture, smallFixture } from "./fixtures";

function textWithDelimiter(headers: string[], rows: string[][], delimiter: string): string {
  return Papa.unparse({ fields: headers, data: rows }, { delimiter });
}

test("separator dropdown shows the detected 'Auto (;)' for a semicolon fixture", async ({ page }) => {
  const text = textWithDelimiter(smallFixture.headers, smallFixture.rows, ";");
  await bootAndLoadText(page, {
    fileKey: "file:///semi.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 4,
  });

  await expect(page.locator("#separator-select")).toHaveValue("");
  await expect(page.locator("#separator-select option:checked")).toHaveText("Auto (;)");
  // And it actually split on ';', not just guessed the label.
  await expect(page.locator("#table-head th.sortable")).toHaveCount(4);
});

test("switching the separator to Comma re-splits the columns and resets to page 1", async ({ page }) => {
  const fixture = largeFixture(150); // 2 pages @ the default page size of 100
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

  // None of the fixture's fields contain a literal comma, so re-parsing
  // with "," as the delimiter collapses every row to a single column.
  await page.locator("#separator-select").selectOption(",");
  await expect(page.locator("#table-head th.sortable")).toHaveCount(1);
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
});

test("Custom… reveals an input, and a custom || delimiter re-parses correctly", async ({ page }) => {
  const text = textWithDelimiter(smallFixture.headers, smallFixture.rows, "||");
  // defaultTableColumns is generous here (well above the fixture's real
  // column count) so that the *initial* Auto-detected parse — which, before
  // the user picks "||", naively guesses a single "|" and over-splits into
  // 7 bogus columns — doesn't leave any of the real header names (id, name,
  // age, city) stuck hidden by the default-N rule; that stale visibility
  // would otherwise carry over once reconciled against the correct parse,
  // which is a documented, intentional part of reconciliation (keep the
  // visibility of columns whose *name* still exists) but not what this
  // test is about.
  await bootAndLoadText(page, {
    fileKey: "file:///pipe2.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 8,
  });

  await page.locator("#separator-select").selectOption("custom");
  await expect(page.locator("#separator-custom")).toBeVisible();
  await page.locator("#separator-custom").fill("||");

  await expect(page.locator("#table-head th.sortable")).toHaveCount(4);
  await expect(page.locator("#table-head th", { hasText: "age" })).toHaveCount(1);
  await expect(page.locator("tr.data-row").first()).toContainText("Alice");

  // The choice is persisted via saveState.
  const saved = await awaitPosted(page, "saveState");
  expect((saved.state as { delimiter: string }).delimiter).toBe("||");
});

test("an empty custom value falls back to Auto", async ({ page }) => {
  const text = textWithDelimiter(smallFixture.headers, smallFixture.rows, ";");
  await bootAndLoadText(page, {
    fileKey: "file:///semi-custom.csv",
    text,
    state: defaultViewState({ delimiter: "||" }), // starts on an unmatched custom value
    defaultTableColumns: 4,
  });
  await expect(page.locator("#separator-select")).toHaveValue("custom");
  await expect(page.locator("#separator-custom")).toBeVisible();

  await page.locator("#separator-custom").fill("");

  await expect(page.locator("#separator-select")).toHaveValue("");
  const saved = await awaitPosted(page, "saveState");
  expect((saved.state as { delimiter: string }).delimiter).toBe("");
});

test("a load with state.delimiter set honors it, taking precedence over auto-detection", async ({ page }) => {
  // Two commas per data line make comma a plausible (wrong) auto-detected
  // delimiter; forcing "|" via stored state must win regardless.
  const text = "name|amount\nWidget, Inc|1,000\nGadget, LLC|2,000";
  await bootAndLoadText(page, {
    fileKey: "file:///forced-pipe.csv",
    text,
    state: defaultViewState({ delimiter: "|" }),
    defaultTableColumns: 2,
  });

  await expect(page.locator("#table-head th.sortable")).toHaveCount(2);
  await expect(page.locator("tr.data-row").first()).toContainText("Widget, Inc");
  await expect(page.locator("#separator-select")).toHaveValue("|");
});

test("defaultDelimiter '\\t' is used when the stored state has none", async ({ page }) => {
  const text = "a\tb\tc\n1\t2\t3\n4\t5\t6";
  await bootAndLoadText(page, {
    fileKey: "file:///tabs.tsv",
    text,
    state: defaultViewState(), // delimiter: "" — nothing stored yet
    defaultTableColumns: 3,
    defaultDelimiter: "\t",
  });

  await expect(page.locator("#table-head th.sortable")).toHaveCount(3);
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
