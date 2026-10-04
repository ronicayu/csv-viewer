import { expect, test } from "@playwright/test";
import { bootAndLoadText, defaultViewState, pushLoadText } from "../harness";
import { trackConsoleErrors, wideFixtureText } from "./stressHelpers";

async function openFormatPopover(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#format-btn").click();
  await expect(page.locator("#format-popover")).toBeVisible();
}

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
  await openFormatPopover(page);

  await page.locator("#separator-select").selectOption(",");
  await expect(page.locator("th.sortable")).toHaveCount(5);

  await page.locator("#separator-select").selectOption(";");
  await expect(page.locator("th.sortable")).toHaveCount(1);

  await page.locator("#separator-select").selectOption("\t");
  await expect(page.locator("th.sortable")).toHaveCount(1);

  await page.locator("#separator-select").selectOption("|");
  await expect(page.locator("th.sortable")).toHaveCount(1);

  await page.locator("#separator-select").selectOption("");
  await expect(page.locator("th.sortable")).toHaveCount(5);
  await expect(page.locator("#status-bar")).toHaveText("Showing 20,000 of 20,000 rows");
  expect(consoleErrors).toEqual([]);
});

test("a Custom separator of a single space can now actually be applied — the input is no longer trimmed before use", async ({
  page,
}) => {
  const text = "a b c\n1 2 3\n4 5 6";
  await bootAndLoadText(page, {
    fileKey: "file:///space-sep.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await openFormatPopover(page);
  await page.locator("#separator-select").selectOption("custom");
  await page.locator("#separator-custom").fill(" ");

  await expect(page.locator("th.sortable")).toHaveCount(3);
  await expect(page.locator("tr.data-row").first()).toContainText("2");
});

test('a Custom separator of a double-quote is rejected with an inline error when Quoted fields is on, and honored once Quoted fields is turned off (manually, or via the error\'s "Turn Off" link)', async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  const text = 'a"b\n1"2';
  await bootAndLoadText(page, {
    fileKey: "file:///quote-sep.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 2,
  });
  await expect(page.locator("th.sortable")).toHaveCount(1);

  await openFormatPopover(page);
  await page.locator("#separator-select").selectOption("custom");
  await page.locator("#separator-custom").fill('"');

  await expect(page.locator("#separator-custom-error")).toBeVisible();
  await expect(page.locator("#separator-custom-error")).toContainText('Can\'t use " while Quoted fields is on.');
  await expect(page.locator("#separator-custom")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#separator-custom")).toHaveAttribute("aria-describedby", "separator-custom-error");
  await expect(page.locator("th.sortable")).toHaveCount(1);

  await page.locator("#separator-custom-error button", { hasText: "Turn Off" }).click();

  await expect(page.locator("#separator-custom-error")).toBeHidden();
  await expect(page.locator("#quotes-checkbox")).not.toBeChecked();
  await expect(page.locator("th.sortable")).toHaveCount(2);
  await expect(page.locator("tr.data-row").first()).toContainText("2");
  expect(consoleErrors).toEqual([]);
});

test('manually turning off Quoted fields first, then typing a Custom "` separator, is accepted the same way', async ({ page }) => {
  const text = 'a"b\n1"2';
  await bootAndLoadText(page, {
    fileKey: "file:///quote-sep-manual.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 2,
  });
  await openFormatPopover(page);
  await page.locator("#quotes-checkbox").uncheck();
  await page.locator("#separator-select").selectOption("custom");
  await page.locator("#separator-custom").fill('"');

  await expect(page.locator("#separator-custom-error")).toBeHidden();
  await expect(page.locator("th.sortable")).toHaveCount(2);
  await expect(page.locator("tr.data-row").first()).toContainText("2");
});

test("switching the separator so a filter rule's column disappears leaves that rule ignored (inert), not filtering out the whole file", async ({
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
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 3 rows");

  await openFormatPopover(page);
  await page.locator("#separator-select").selectOption("|");
  await expect(page.locator("th.sortable")).toHaveCount(1);
  await expect(page.locator("#status-bar")).toHaveText("Showing 3 of 3 rows");
  await page.locator("#filters-btn").click();
  await expect(page.locator(".rule-row.rule-error")).toHaveCount(1);
  await expect(page.locator(".rule-row.rule-error .rule-error-text")).toContainText("isn't in this file");
});

test("a reload landing while Custom… is being edited keeps the custom input open and its typed text", async ({ page }) => {
  const text = "a;b\n1;2\n";
  const load = { fileKey: "file:///race.csv", text, state: defaultViewState(), defaultTableColumns: 2 };
  await bootAndLoadText(page, load);

  await openFormatPopover(page);
  await page.locator("#separator-select").selectOption("custom");
  await expect(page.locator("#separator-custom")).toBeVisible();

  await pushLoadText(page, { ...load, text: "a;b\n1;2\n3;4\n" });
  await expect(page.locator("#status-bar")).toHaveText("Showing 2 of 2 rows");

  await expect(page.locator("#separator-custom")).toBeVisible();
  await expect(page.locator("#separator-select")).toHaveValue("custom");

  await page.locator("#separator-custom").fill(";");
  await expect(page.locator("th.sortable")).toHaveCount(2);
});
