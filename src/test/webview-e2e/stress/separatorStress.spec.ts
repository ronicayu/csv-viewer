// Separator stress: cycling through every preset on a 20k-row file, Custom
// with a quote character, a space, and empty, and switching separators
// while a filter rule references a column that the new parse removes.

import { expect, test } from "@playwright/test";
import { bootAndLoadText, defaultViewState } from "../harness";
import { trackConsoleErrors, wideFixtureText } from "./stressHelpers";

test("cycling through Auto/Comma/Semicolon/Tab/Pipe on a 20k-row comma file re-parses correctly (or collapses to 1 column) every time, without errors", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const text = wideFixtureText(20_000, 5, ",");
  await bootAndLoadText(page, {
    fileKey: "file:///sepstress20k.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 5,
  });
  await expect(page.locator("th.sortable")).toHaveCount(5);

  // Comma explicitly -> still 5 columns.
  await page.locator("#separator-select").selectOption(",");
  await expect(page.locator("th.sortable")).toHaveCount(5);

  // None of the generated cells contain ';', '\t', or '|', so forcing any
  // of those collapses every row to a single column instead of erroring.
  await page.locator("#separator-select").selectOption(";");
  await expect(page.locator("th.sortable")).toHaveCount(1);

  await page.locator("#separator-select").selectOption("\t");
  await expect(page.locator("th.sortable")).toHaveCount(1);

  await page.locator("#separator-select").selectOption("|");
  await expect(page.locator("th.sortable")).toHaveCount(1);

  // Back to Auto -> re-detects comma, 5 columns again.
  await page.locator("#separator-select").selectOption("");
  await expect(page.locator("th.sortable")).toHaveCount(5);
  await expect(page.locator("#status-bar")).toHaveText("Showing 20000 of 20000 rows");
  expect(consoleErrors).toEqual([]);
});

test("BUG: a Custom separator of a single space can never actually be applied — the input is trimmed before use, so it silently falls back to Auto", async ({
  page,
}) => {
  test.fail(); // see comment below for expected behavior
  const text = "a b c\n1 2 3\n4 5 6";
  await bootAndLoadText(page, {
    fileKey: "file:///space-sep.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await page.locator("#separator-select").selectOption("custom");
  await page.locator("#separator-custom").fill(" ");

  // Expected: a single space is a perfectly valid 1-character delimiter
  // (the input's maxlength is 5, and nothing in the spec singles out
  // whitespace as disallowed) — it should split "a b c" into 3 columns.
  // Actual: the custom-input 'input' handler (src/webview/main.ts) calls
  // `applySeparatorChange(separatorCustomInput.value.trim())`, so a
  // value of exactly " " becomes "" after trim and falls back to Auto —
  // which then guesses among [",",";","\t","|"], none present, and Papa
  // collapses the whole line into 1 column. There is no way to type a
  // pure-whitespace custom separator at all.
  await expect(page.locator("th.sortable")).toHaveCount(3); // fails: 1
  await expect(page.locator("tr.data-row").first()).toContainText("2");
});

test("BUG: a Custom separator of a double-quote silently falls back to auto-detected comma instead of the requested delimiter, so the Separator dropdown lies about what actually produced the table", async ({
  page,
}) => {
  test.fail(); // see comment below for expected behavior
  const consoleErrors = trackConsoleErrors(page);
  const text = "a,b\n1,2\n3,4"; // no literal '"' anywhere in the data
  await bootAndLoadText(page, {
    fileKey: "file:///quote-sep.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 2,
  });

  await page.locator("#separator-select").selectOption("custom");
  await page.locator("#separator-custom").fill('"');

  // Expected: forcing '"' as the delimiter — since it never occurs in the
  // text — should behave like any other absent delimiter and collapse
  // every row to 1 column (same as the ';'/Tab/'|' cases above), while
  // the Separator dropdown keeps showing the user's actual "Custom…" `"`
  // choice.
  // Actual: Papa Parse, given `delimiter: '"'` together with the fixed
  // `quoteChar: '"'` (src/core/csvParse.ts), silently ignores the forced
  // delimiter and falls through to its own guessing among
  // `delimitersToGuess`, landing on comma — so the table renders 2
  // columns (a, b) even though the UI says a custom `"` separator is
  // active. No crash, but the displayed data doesn't match the stated
  // parse configuration.
  await expect(page.locator("th.sortable")).toHaveCount(1); // fails: 2 (a, b via guessed comma)
  expect(consoleErrors).toEqual([]);
});

test("switching the separator so a filter rule's column disappears makes that include-rule match zero rows (documented as inert-if-stale, but 'inert' means the whole file, not a no-op)", async ({
  page,
}) => {
  const text = "id,age,city\n1,30,NYC\n2,20,LA\n3,40,SF";
  await bootAndLoadText(page, {
    fileKey: "file:///filter-then-sep.csv",
    text,
    state: defaultViewState({
      filterRules: [
        { id: "r1", column: "age", operator: "gt", value: "10", mode: "include", caseSensitive: false, enabled: true },
      ],
    }),
    defaultTableColumns: 3,
  });
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 3 rows"); // all ages > 10

  // Force "|" as the separator; nothing in the text contains it, so the
  // three original columns collapse into one and "age" no longer exists.
  await page.locator("#separator-select").selectOption("|");
  await expect(page.locator("th.sortable")).toHaveCount(1);
  // The stale include-rule on "age" can never match (columnIndex === -1),
  // so *every* row is dropped, not just left unfiltered.
  await expect(page.locator("#status-bar")).toHaveText("Showing 0 of 3 rows");
});
