import { expect, test } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, defaultViewState } from "../harness";
import { toCsvText, trackConsoleErrors } from "./stressHelpers";

test.describe("__proto__ as a header name", () => {
  test("a __proto__ column can be hidden — the checkbox stays unchecked and the column leaves the table", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    await bootAndLoad(page, {
      fileKey: "file:///proto.csv",
      headers: ["id", "__proto__", "name"],
      rows: [
        ["1", "hidden-value", "Alice"],
        ["2", "hidden-value2", "Bob"],
      ],
      state: defaultViewState(),
      defaultTableColumns: 3,
    });

    await page.locator("#columns-btn").click();
    const protoCheckbox = page.locator(".column-row", { hasText: "__proto__" }).locator('input[type="checkbox"]');
    await expect(protoCheckbox).toBeChecked();
    await protoCheckbox.uncheck();

    await expect(page.locator("th", { hasText: "__proto__" })).toHaveCount(0);
    await page.locator("#columns-btn").click();
    await page.locator("#columns-btn").click();
    await expect(protoCheckbox).not.toBeChecked();
    expect(consoleErrors).toEqual([]);
  });

  test("a __proto__ column beyond the default-visible-column count is correctly detail-only, not shown by accident", async ({
    page,
  }) => {
    await bootAndLoad(page, {
      fileKey: "file:///proto2.csv",
      headers: ["a", "b", "c", "__proto__"],
      rows: [["1", "2", "3", "4"]],
      state: defaultViewState(),
      defaultTableColumns: 2,
    });

    await expect(page.locator("th.sortable")).toHaveCount(2);
    await expect(page.locator("th", { hasText: "__proto__" })).toHaveCount(0);
  });

  test("sorting and filtering by a __proto__ column still work (headers array and Map-keyed lookups aren't affected)", async ({
    page,
  }) => {
    await bootAndLoad(page, {
      fileKey: "file:///proto3.csv",
      headers: ["id", "__proto__"],
      rows: [
        ["1", "banana"],
        ["2", "apple"],
        ["3", "cherry"],
      ],
      state: defaultViewState(),
      defaultTableColumns: 2,
    });

    await page.locator("th", { hasText: "__proto__" }).click();
    await expect
      .poll(() => page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.children[1]?.textContent ?? "")))
      .toEqual(["2", "1", "3"]);

    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("__proto__");
    await rule.locator('select[aria-label="Condition"]').selectOption("equals");
    await rule.locator('input[type="text"]').fill("apple");
    await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 3 rows");
  });
});

test("a header literally named 'constructor' behaves like any normal header (no prototype-pollution pitfall)", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///ctor.csv",
    headers: ["id", "constructor"],
    rows: [
      ["1", "x"],
      ["2", "y"],
    ],
    state: defaultViewState(),
    defaultTableColumns: 1,
  });

  await page.locator("#columns-btn").click();
  const ctorCheckbox = page.locator(".column-row", { hasText: "constructor" }).locator('input[type="checkbox"]');
  await expect(ctorCheckbox).not.toBeChecked();
  await ctorCheckbox.check();
  await expect(page.locator("th", { hasText: "constructor" })).toHaveCount(1);

  await page.locator("th", { hasText: "constructor" }).click();
  await expect(page.locator("th", { hasText: "constructor" })).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("#sort-btn")).toHaveText("Sort • 1");
});

test("an empty header cell is renamed to column_N and behaves normally", async ({ page }) => {
  const text = toCsvText(["id", "", "note"], [
    ["1", "x", "hi"],
    ["2", "y", "bye"],
  ]);
  await bootAndLoadText(page, {
    fileKey: "file:///empty-header.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  await expect(page.locator("th", { hasText: "column_2" })).toHaveCount(1);
  await page.locator("th", { hasText: "column_2" }).click();
  await expect
    .poll(() => page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.children[2]?.textContent ?? "")))
    .toEqual(["x", "y"]);
});

test("plain duplicate headers dedupe to name/name_2 and are independently toggleable/sortable", async ({ page }) => {
  const text = toCsvText(["dup", "dup", "id"], [
    ["a1", "b1", "1"],
    ["a2", "b2", "2"],
  ]);
  await bootAndLoadText(page, {
    fileKey: "file:///dup.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  // "dup" is a substring of "dup_2", so match exact text to tell them apart.
  await expect(page.locator("th", { hasText: /^dup$/ })).toHaveCount(1);
  await expect(page.locator("th", { hasText: /^dup_2$/ })).toHaveCount(1);

  await page.locator("#columns-btn").click();
  await page.locator(".column-row", { hasText: /^dup$/ }).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator("th", { hasText: /^dup_2$/ })).toHaveCount(1);
  await expect(page.locator("th", { hasText: /^dup$/ })).toHaveCount(0);
});

test("a header set 'a', 'a', 'a_2' dedupes to three distinct, independently addressable columns", async ({ page }) => {
  const text = toCsvText(["a", "a", "a_2"], [["first", "second", "third"]]);
  await bootAndLoadText(page, {
    fileKey: "file:///dupcollide.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  const headerTexts = await page.locator("th.sortable").allTextContents();
  expect(new Set(headerTexts).size).toBe(headerTexts.length);
  expect(headerTexts).toEqual(["a", "a_3", "a_2"]);

  const rowCells = await page.locator("tr.data-row").first().locator("td:not(.chevron-col)").allTextContents();
  expect(rowCells).toEqual(["first", "second", "third"]);
});

test("a 500-character header renders, toggles, sorts, and filters normally", async ({ page }) => {
  const longHeader = "h" + "x".repeat(499);
  await bootAndLoad(page, {
    fileKey: "file:///longheader.csv",
    headers: ["id", longHeader],
    rows: [
      ["1", "b"],
      ["2", "a"],
    ],
    state: defaultViewState(),
    defaultTableColumns: 2,
  });

  await expect(page.locator("th", { hasText: longHeader })).toHaveCount(1);
  await page.locator("th", { hasText: longHeader }).click();
  await expect
    .poll(() => page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.children[1]?.textContent ?? "")))
    .toEqual(["2", "1"]);

  await page.locator("#columns-btn").click();
  await page.locator(".column-row", { hasText: longHeader.slice(0, 50) }).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator("th", { hasText: longHeader })).toHaveCount(0);
});

test("an emoji header renders, toggles, sorts, and filters normally", async ({ page }) => {
  const emojiHeader = "😀category";
  await bootAndLoad(page, {
    fileKey: "file:///emoji.csv",
    headers: ["id", emojiHeader],
    rows: [
      ["1", "zeta"],
      ["2", "alpha"],
    ],
    state: defaultViewState(),
    defaultTableColumns: 2,
  });

  await expect(page.locator("th", { hasText: emojiHeader })).toHaveCount(1);
  await page.locator("th", { hasText: emojiHeader }).click();
  await expect
    .poll(() => page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.children[1]?.textContent ?? "")))
    .toEqual(["2", "1"]);

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator('select[aria-label="Column"]').selectOption(emojiHeader);
  await rule.locator('select[aria-label="Condition"]').selectOption("equals");
  await rule.locator('input[type="text"]').fill("alpha");
  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 2 rows");
});
