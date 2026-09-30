// Separator stress: cycling through every preset on a 20k-row file, Custom
// with a quote character, a space, and empty, and switching separators
// while a filter rule references a column that the new parse removes.

import { expect, test } from "@playwright/test";
import { bootAndLoadText, defaultViewState, pushLoadText } from "../harness";
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

test("a Custom separator of a single space can now actually be applied — the input is no longer trimmed before use", async ({
  page,
}) => {
  // FIXED: the custom-input 'input' handler (src/webview/main.ts) no
  // longer trims the typed value before applying it — only a truly empty
  // input (never a whitespace-only one) falls back to Auto. A single
  // space is a perfectly valid 1-character delimiter.
  const text = "a b c\n1 2 3\n4 5 6";
  await bootAndLoadText(page, {
    fileKey: "file:///space-sep.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await page.locator("#separator-select").selectOption("custom");
  await page.locator("#separator-custom").fill(" ");

  await expect(page.locator("th.sortable")).toHaveCount(3);
  await expect(page.locator("tr.data-row").first()).toContainText("2");
});

test('a Custom separator of a double-quote is rejected with an inline error when Quoted fields is on, and honored once Quoted fields is turned off', async ({
  page,
}) => {
  // FIXED (decision): `"` conflicts with Papa's quoteChar while quoting is
  // on, so the webview now rejects it up front with an inline error
  // instead of silently falling back to auto-detected comma — the
  // Separator control never claims a delimiter that isn't actually
  // active. With "Quoted fields" off, `"` is an ordinary, valid
  // delimiter (see src/core/csvParse.ts's QUOTE_DELIMITER_PLACEHOLDER
  // workaround for Papa's hardcoded refusal to use `"` as a delimiter).
  const consoleErrors = trackConsoleErrors(page);
  const text = 'a"b\n1"2'; // literal '"' separates real fields here
  await bootAndLoadText(page, {
    fileKey: "file:///quote-sep.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 2,
  });
  // Auto-detected as one column while quoting is on (no comma/semicolon/
  // tab/pipe present, and the `"` in the text isn't a real quote-open
  // since it's not the first character of either field).
  await expect(page.locator("th.sortable")).toHaveCount(1);

  await page.locator("#separator-select").selectOption("custom");
  await page.locator("#separator-custom").fill('"');

  // Rejected: an inline error appears, and the table is unchanged (still
  // 1 column) — the rejected value was never applied (state.view.delimiter
  // stays "", i.e. Auto).
  await expect(page.locator("#separator-custom-error")).toBeVisible();
  await expect(page.locator("#separator-custom-error")).toHaveText('" is the quote character — turn off Quoted fields to use it');
  await expect(page.locator("th.sortable")).toHaveCount(1);

  // Turn off "Quoted fields", then try the same custom value again — the
  // rejected attempt above never got as far as being stored, so the
  // control reset back to Auto/hidden; picking "Custom…" and typing `"`
  // fresh is now accepted since there's no quoteChar conflict anymore.
  await page.locator("#quotes-checkbox").uncheck();
  await page.locator("#separator-select").selectOption("custom");
  await page.locator("#separator-custom").fill('"');

  await expect(page.locator("#separator-custom-error")).toBeHidden();
  await expect(page.locator("th.sortable")).toHaveCount(2);
  await expect(page.locator("tr.data-row").first()).toContainText("2");
  expect(consoleErrors).toEqual([]);
});

test("switching the separator so a filter rule's column disappears leaves that rule ignored (inert), not filtering out the whole file", async ({
  page,
}) => {
  // Changed behavior (bug fix, decision #10, not a regression): a rule
  // whose column no longer exists is now ignored via isRuleActive
  // (src/core/filter.ts), not applied as "matches nothing" — which, for
  // an include rule, used to drop every row in the file. This test's
  // original title/expectation ("inert' means the whole file") described
  // exactly the behavior that decision reverses.
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
  // The stale include-rule on "age" is now ignored, so all rows remain.
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 3 rows");
  // The filter panel shows a "column not found" hint on that rule.
  await page.locator("#filters-btn").click();
  await expect(page.locator(".rule-row.rule-error")).toHaveCount(1);
  await expect(page.locator(".rule-row.rule-error .rule-error-text")).toContainText("Column not found");
});

test("a reload landing while Custom… is being edited keeps the custom input open and its typed text", async ({ page }) => {
  // Regression: every parse result re-rendered the separator control from
  // the stored delimiter, so a reload (or a re-parse from toggling Quoted
  // fields) arriving between picking Custom… and typing hid the input.
  const text = "a;b\n1;2\n";
  const load = { fileKey: "file:///race.csv", text, state: defaultViewState(), defaultTableColumns: 2 };
  await bootAndLoadText(page, load);

  await page.locator("#separator-select").selectOption("custom");
  await expect(page.locator("#separator-custom")).toBeVisible();

  await pushLoadText(page, { ...load, text: "a;b\n1;2\n3;4\n" });
  await expect(page.locator("#status-bar")).toHaveText("Showing 2 of 2 rows");

  await expect(page.locator("#separator-custom")).toBeVisible();
  await expect(page.locator("#separator-select")).toHaveValue("custom");

  await page.locator("#separator-custom").fill(";");
  await expect(page.locator("th.sortable")).toHaveCount(2);
});
