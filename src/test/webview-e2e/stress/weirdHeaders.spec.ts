// Weird header names: __proto__, constructor, empty, duplicate (including a
// dedupe-collision case), a 500-char name, and an emoji name. Each is
// exercised through visibility toggling, sorting, and filtering.
//
// `ColumnVisibilityMap` (src/core/columns.ts, src/core/types.ts) is a plain
// JS object keyed by header name, not a `Map`. A header literally named
// `__proto__` turns every write to `visibility["__proto__"]` into a no-op
// (bracket assignment of a non-object value to `__proto__` is defined by
// the spec to do nothing), while every *read* returns `Object.prototype`
// (an object, so always `!== false`) instead of the value that was
// "written". That produces a real, reproducible bug below.

import { expect, test } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, defaultViewState } from "../harness";
import { toCsvText, trackConsoleErrors } from "./stressHelpers";

test.describe("__proto__ as a header name", () => {
  test("BUG: a __proto__ column cannot be hidden — the checkbox snaps back to checked and the column stays in the table", async ({
    page,
  }) => {
    test.fail(); // see comment below for expected behavior
    const consoleErrors = trackConsoleErrors(page);
    await bootAndLoad(page, {
      fileKey: "file:///proto.csv",
      headers: ["id", "__proto__", "name"],
      rows: [
        ["1", "hidden-value", "Alice"],
        ["2", "hidden-value2", "Bob"],
      ],
      state: defaultViewState(),
      defaultTableColumns: 3, // all visible to start
    });

    await page.locator("#columns-btn").click();
    const protoCheckbox = page.locator(".column-row", { hasText: "__proto__" }).locator('input[type="checkbox"]');
    await expect(protoCheckbox).toBeChecked();
    await protoCheckbox.uncheck();

    // Expected: unchecking hides the column, exactly like any other header
    // (see columns.spec.ts's "age" case) — the "__proto__" <th> disappears
    // and re-opening the popover shows the checkbox still unchecked.
    // Actual: `state.view.columnVisibility["__proto__"] = false` is a
    // silent no-op (src/webview/main.ts's columnsList checkbox change
    // handler, and ultimately src/core/columns.ts's `visibleColumns`
    // reading `visibility[h] !== false`), so the column never leaves the
    // table and the checkbox reverts to checked on the next render.
    await expect(page.locator("th", { hasText: "__proto__" })).toHaveCount(0); // fails: still 1
    expect(consoleErrors).toEqual([]);
  });

  test("BUG: a __proto__ column beyond the default-visible-column count still shows up in the table", async ({ page }) => {
    test.fail(); // see comment below for expected behavior
    await bootAndLoad(page, {
      fileKey: "file:///proto2.csv",
      headers: ["a", "b", "c", "__proto__"],
      rows: [["1", "2", "3", "4"]],
      state: defaultViewState(),
      defaultTableColumns: 2, // only "a" and "b" should start visible
    });

    // Expected: table shows exactly "a" and "b"; "c" and "__proto__" are
    // detail-only, same default-N rule as every other column (see
    // src/core/columns.ts's defaultVisibility).
    // Actual: `map["__proto__"] = (3 < 2) = false` is a silent no-op (same
    // root cause as above), so reading it back yields Object.prototype —
    // an object, therefore `!== false` — and the column renders anyway.
    await expect(page.locator("th.sortable")).toHaveCount(2); // fails: 3 (a, b, __proto__)
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
    const idColumn = page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.children[1]?.textContent ?? ""));
    expect(await idColumn).toEqual(["2", "1", "3"]); // apple, banana, cherry -> ids 2,1,3

    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator("select").nth(0).selectOption("__proto__");
    await rule.locator("select").nth(1).selectOption("equals");
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
    defaultTableColumns: 1, // "constructor" starts detail-only
  });

  await page.locator("#columns-btn").click();
  const ctorCheckbox = page.locator(".column-row", { hasText: "constructor" }).locator('input[type="checkbox"]');
  await expect(ctorCheckbox).not.toBeChecked();
  await ctorCheckbox.check();
  await expect(page.locator("th", { hasText: "constructor" })).toHaveCount(1);

  await page.locator("th", { hasText: "constructor" }).click();
  await expect(page.locator("#sort-by-select")).toHaveValue("constructor");
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
  await page.locator("th", { hasText: "column_2" }).click(); // sort
  const col2 = await page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.children[2]?.textContent ?? ""));
  expect(col2).toEqual(["x", "y"]);
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

  // Hiding "dup" must not affect "dup_2".
  await page.locator("#columns-btn").click();
  await page.locator(".column-row", { hasText: /^dup$/ }).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator("th", { hasText: /^dup_2$/ })).toHaveCount(1);
  await expect(page.locator("th", { hasText: /^dup$/ })).toHaveCount(0);
});

test("BUG: a header set 'a', 'a', 'a_2' dedupes to a colliding pair of 'a_2' columns that alias each other's data", async ({
  page,
}) => {
  test.fail(); // see comment below for expected behavior
  // dedupeNames (src/core/csvParse.ts) tracks how many times it has seen
  // each *original* name, but doesn't check whether the name it generates
  // (`${name}_${count+1}`) collides with a name that was already in the
  // input. Header row ["a", "a", "a_2"] dedupes to ["a", "a_2", "a_2"] —
  // two columns with the identical final name "a_2".
  const text = toCsvText(["a", "a", "a_2"], [["first", "second", "third"]]);
  await bootAndLoadText(page, {
    fileKey: "file:///dupcollide.csv",
    text,
    state: defaultViewState(),
    defaultTableColumns: 3,
  });

  // Expected: three distinct, independently addressable columns (e.g.
  // "a", "a_2", "a_3", or some other collision-free scheme) each showing
  // its own original cell value ("first", "second", "third").
  // Actual: `state.headers` contains "a_2" twice. Every `Map(headers.map((h,
  // i) => [h, i]))` lookup by header name (used throughout main.ts, e.g.
  // buildRowTr's `indexByHeader`) then resolves "a_2" to only the *last*
  // matching index, so both "a_2" <th> columns render the same ("third")
  // value and the true second column's data ("second") is not shown
  // anywhere in the table.
  const headerTexts = await page.locator("th.sortable").allTextContents();
  expect(new Set(headerTexts).size).toBe(headerTexts.length); // fails: two "a_2"s

  const rowCells = await page.locator("tr.data-row").first().locator("td:not(.chevron-col)").allTextContents();
  expect(rowCells).toEqual(["first", "second", "third"]); // fails: ["first", "third", "third"]
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
  const idCol = await page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.children[1]?.textContent ?? ""));
  expect(idCol).toEqual(["2", "1"]); // sorted by the long-named column ascending: a, b -> ids 2, 1

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
  const idCol = await page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.children[1]?.textContent ?? ""));
  expect(idCol).toEqual(["2", "1"]);

  await page.locator("#filters-btn").click();
  await page.locator("#add-rule-btn").click();
  const rule = page.locator(".rule-row").first();
  await rule.locator("select").nth(0).selectOption(emojiHeader);
  await rule.locator("select").nth(1).selectOption("equals");
  await rule.locator('input[type="text"]').fill("alpha");
  await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 2 rows");
});
