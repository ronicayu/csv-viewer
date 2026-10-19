import { expect, test, type Page } from "@playwright/test";
import { awaitPosted, bootShell, clearPosted, defaultViewState, posted, pushLoadText } from "../harness";
import { trackConsoleErrors } from "./stressHelpers";

const CI_SLACK = process.env.CI ? 2 : 1;
// Strict wall-clock bounds apply only when PERF_TESTS=1; the DOM-size guards below do not depend on timing.
const STRICT = process.env.PERF_TESTS === "1";
const MANY_COLUMNS = 1000;

// A header row of one name and a single data row of `columns` nine-character cells: what writeSingleLongLineCsv makes.
function singleLineText(columns: number): string {
  return "header\n" + Array.from({ length: columns }, () => "xxxxxxxxx").join(",") + "\n";
}

// Generated in the page: megabytes of text through Playwright's arguments would skew the timing.
async function pushGeneratedSingleLine(page: Page, bytes: number): Promise<number> {
  await page.evaluate((target) => {
    const cell = "x".repeat(9) + ",";
    const line = cell.repeat(Math.ceil(target / cell.length)).replace(/,$/, "");
    (window as unknown as { __lineText: string }).__lineText = "header\n" + line + "\n";
  }, bytes);
  const start = Date.now();
  await page.evaluate((state) => {
    const w = window as unknown as { __lineText?: string };
    window.postMessage({ type: "load", fileKey: "file:///line.csv", text: w.__lineText, state, defaultTableColumns: 8, defaultDelimiter: "" }, "*");
    delete w.__lineText;
  }, defaultViewState());
  await expect(page.locator("tr.data-row").first()).toBeVisible({ timeout: 60_000 });
  return Date.now() - start;
}

const elementCount = (page: Page): Promise<number> => page.evaluate(() => document.getElementsByTagName("*").length);

test.describe("a file with a very large number of columns", () => {
  test("a 1 x 200,000 file renders a bounded DOM, before and after the row is expanded", async ({ page }) => {
    test.setTimeout(120_000);
    const consoleErrors = trackConsoleErrors(page);
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text: singleLineText(200_000), state: defaultViewState(), defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1, { timeout: 60_000 });
    expect(await elementCount(page)).toBeLessThan(20_000);
    await expect(page.locator("#columns-btn")).toHaveText("Columns 8/200000");

    await page.locator("tr.data-row").first().click();
    await expect(page.locator("tr.detail-row:not([hidden]) dt")).toHaveCount(MANY_COLUMNS);
    await expect(page.locator("button.detail-show-all-fields")).toHaveText("Show all 199,992 fields");
    expect(await elementCount(page)).toBeLessThan(20_000);
    expect(consoleErrors).toEqual([]);
  });

  test("the Columns, Sort and Filter lists stop at 1,000 columns and say so", async ({ page }) => {
    test.setTimeout(120_000);
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text: singleLineText(200_000), state: defaultViewState(), defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1, { timeout: 60_000 });

    await page.locator("#columns-btn").click();
    await expect(page.locator("#columns-list label.column-row")).toHaveCount(MANY_COLUMNS);
    await expect(page.locator("#columns-list .column-row-more")).toHaveText("Showing 1,000 of 200,000 columns — type to narrow");
    await page.locator("#columns-search").fill("column_19999");
    await expect(page.locator("#columns-list label.column-row")).toHaveCount(11);
    await expect(page.locator("#columns-list .column-row-more")).toHaveCount(0);
    await page.locator("#columns-search").fill("column_1");
    await expect(page.locator("#columns-list label.column-row")).toHaveCount(MANY_COLUMNS);
    await expect(page.locator("#columns-list .column-row-more")).toHaveText(/^Showing 1,000 of 1\d\d,\d{3} columns — type to narrow$/);
    await page.locator("#columns-search").fill("");

    await page.locator("#sort-btn").click();
    await expect(page.locator("#sort-add-select option")).toHaveCount(MANY_COLUMNS + 2);
    await expect(page.locator("#sort-add-select option").last()).toHaveText("… 199,000 more columns");
    await expect(page.locator("#sort-many-note")).toBeVisible();
    await expect(page.locator("#sort-many-note")).toHaveText("Use the column header or the Columns search to sort by a column that isn't listed.");

    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    await expect(page.locator('.rule-row select[aria-label="Column"] option')).toHaveCount(MANY_COLUMNS + 2);
    await expect(page.locator('.rule-row select[aria-label="Column"] option').last()).toHaveText("… 199,000 more columns");
    expect(await elementCount(page)).toBeLessThan(20_000);
  });

  test("sorting by a listed column works, and a column the user narrows to can be moved into the table", async ({ page }) => {
    test.setTimeout(120_000);
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text: singleLineText(50_000), state: defaultViewState(), defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1, { timeout: 60_000 });

    await page.locator("#sort-btn").click();
    await page.locator("#sort-add-select").selectOption("column_20");
    await expect(page.locator(".sort-key-column")).toHaveText("column_20");
    await expect(page.locator("#sort-btn")).toHaveText("Sort • 1");

    await page.locator("#columns-btn").click();
    await page.locator("#columns-search").fill("column_40000");
    await page.locator("#columns-list label.column-row", { hasText: "column_40000" }).locator("input").check();
    await expect(page.locator("th.sortable[data-column='column_40000']")).toHaveCount(1);
    await expect(page.locator("#columns-btn")).toHaveText("Columns 9/50000");
    const saved = (await posted(page)).filter((m) => m.type === "saveState").at(-1) as { state: { columnVisibility: Record<string, boolean> } };
    expect(saved.state.columnVisibility).toEqual({ column_40000: true });
  });

  test("an edit made through Show all fields reaches the host with the right column", async ({ page }) => {
    test.setTimeout(120_000);
    const columns = 3_000;
    const header = Array.from({ length: columns }, (_, i) => `h${i + 1}`).join(",");
    const values = Array.from({ length: columns }, (_, i) => `v${i + 1}`).join(",");
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text: `${header}\n${values}\n`, state: defaultViewState(), defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1);

    await page.locator("tr.data-row").first().click();
    await expect(page.locator("tr.detail-row:not([hidden]) dt")).toHaveCount(MANY_COLUMNS);
    await page.locator("button.detail-show-all-fields").click();
    await expect(page.locator("tr.detail-row:not([hidden]) dt")).toHaveCount(columns - 8);
    await expect(page.locator("button.detail-show-all-fields")).toHaveCount(0);

    const field = page.locator('tr.detail-row:not([hidden]) dd[data-column-index="2499"]');
    await expect(field).toContainText("v2500");
    await page.locator('tr.detail-row:not([hidden]) dt[data-column-index="2499"] .field-edit-btn').click();
    await page.locator("textarea.field-editor").fill("changed");
    await clearPosted(page);
    await page.keyboard.press("Control+Enter");

    const edit = (await awaitPosted(page, "edit")).change as Record<string, any>;
    expect(edit).toMatchObject({ rowId: 0, columnIndex: 2499, column: "h2500", oldValue: "v2500", newValue: "changed" });
    await expect(field).toContainText("changed");
    // The row was rebuilt by the edit; it still lists every field.
    await expect(page.locator("tr.detail-row:not([hidden]) dt")).toHaveCount(columns - 8);
  });

  test("expanding a row with hundreds of fields lays the page out a handful of times, not once per field", async ({ page }) => {
    const columns = 900;
    const header = Array.from({ length: columns }, (_, i) => `h${i + 1}`).join(",");
    const values = Array.from({ length: columns }, (_, i) => `v${i + 1}`).join(",");
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text: `${header}\n${values}\n`, state: defaultViewState(), defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const layouts = async (): Promise<number> => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "LayoutCount")!.value;
    const before = await layouts();
    await page.locator("tr.data-row").first().click();
    await expect(page.locator("tr.detail-row:not([hidden]) dt")).toHaveCount(columns - 8);
    await expect(page.locator("tr.detail-row:not([hidden]) dd .detail-value-text").last()).toHaveText(`v${columns}`);
    // Each field used to measure its own height after the previous one had been written, which is a layout apiece.
    expect(await layouts() - before).toBeLessThan(50);
  });

  test("All in Table on a 20,000-column file renders a capped table and saves one flag, not a key per column", async ({ page }) => {
    test.setTimeout(120_000);
    const columns = 20_000;
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text: singleLineText(columns), state: defaultViewState(), defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1, { timeout: 60_000 });

    await page.locator("#columns-btn").click();
    await clearPosted(page);
    await page.locator("#columns-show-all").click();
    await expect(page.locator("#columns-btn")).toHaveText(`Columns ${columns}/${columns}`);
    await expect(page.locator("th.sortable")).toHaveCount(MANY_COLUMNS);
    await expect(page.locator("#table-cap-banner")).toBeVisible();
    await expect(page.locator("#table-cap-text")).toHaveText("The table shows the first 1,000 of the 20,000 columns chosen for it. The rest are in each row's details.");
    expect(await elementCount(page)).toBeLessThan(20_000);
    const saved = (await posted(page)).filter((m) => m.type === "saveState").at(-1) as { state: { columnVisibility: object; columnDefault?: boolean } };
    expect(saved.state.columnDefault).toBe(true);
    expect(saved.state.columnVisibility).toEqual({});

    // Columns past the cap are not lost: they lead the row's details.
    await page.locator("#columns-btn").click();
    await page.locator("tr.data-row").first().click();
    await expect(page.locator("tr.detail-row:not([hidden]) dt .detail-field-label").first()).toHaveText("column_1001");
    // A thousand table columns and a thousand detail fields, both capped: bounded, not small.
    expect(await elementCount(page)).toBeLessThan(30_000);

    // One toggle on top of the bulk choice is a single key.
    await page.locator("#columns-btn").click();
    await page.locator("#columns-search").fill("column_1001");
    await page.locator("#columns-list label.column-row", { hasText: /^column_1001$/ }).locator("input").uncheck();
    const toggled = (await posted(page)).filter((m) => m.type === "saveState").at(-1) as { state: { columnVisibility: object; columnDefault?: boolean } };
    expect(toggled.state.columnVisibility).toEqual({ column_1001: false });
    expect(toggled.state.columnDefault).toBe(true);
    await expect(page.locator("#columns-btn")).toHaveText(`Columns ${columns - 1}/${columns}`);
  });

  test("All in Details on a 20,000-column file saves one flag and leaves no column in the table", async ({ page }) => {
    test.setTimeout(120_000);
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text: singleLineText(20_000), state: defaultViewState(), defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1, { timeout: 60_000 });
    await page.locator("#columns-btn").click();
    await clearPosted(page);
    await page.locator("#columns-hide-all").click();
    await expect(page.locator("#columns-btn")).toHaveText("Columns 0/20000");
    await expect(page.locator("th.sortable")).toHaveCount(0);
    await expect(page.locator("#table-cap-banner")).toBeHidden();
    const saved = (await posted(page)).filter((m) => m.type === "saveState").at(-1) as { state: { columnVisibility: object; columnDefault?: boolean } };
    expect(saved.state).toMatchObject({ columnVisibility: {}, columnDefault: false });
  });

  test("a saved bulk choice is applied on the next open, and a state with a key per column is compacted", async ({ page }) => {
    test.setTimeout(120_000);
    const columns = 20_000;
    const text = singleLineText(columns);
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text, state: defaultViewState({ columnDefault: true }), defaultTableColumns: 8 });
    await expect(page.locator("th.sortable")).toHaveCount(MANY_COLUMNS, { timeout: 60_000 });
    await expect(page.locator("#columns-btn")).toHaveText(`Columns ${columns}/${columns}`);

    // What 0.8.0 saved for this file: a key for every column, the first eight shown.
    const names = ["header", ...Array.from({ length: columns - 1 }, (_, i) => `column_${i + 2}`)];
    const pinned = Object.fromEntries(names.map((name, i) => [name, i < 8]));
    await bootShell(page);
    await pushLoadText(page, { fileKey: "file:///wide.csv", text, state: defaultViewState({ columnVisibility: pinned }), defaultTableColumns: 8 });
    await expect(page.locator("tr.data-row")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator("th.sortable")).toHaveCount(8);
    const saved = (await posted(page)).filter((m) => m.type === "saveState").at(-1) as { state: { columnVisibility: object } } | undefined;
    expect(saved).toBeDefined();
    expect(JSON.stringify(saved!.state.columnVisibility).length).toBeLessThan(200);
  });

  test("first render stays linear in the width of a single line", async ({ page }) => {
    test.setTimeout(180_000);
    const timings: Record<string, number> = {};
    for (const mb of [2, 8]) {
      await bootShell(page);
      timings[`${mb} MB`] = await pushGeneratedSingleLine(page, mb * 1024 * 1024);
      expect(await elementCount(page)).toBeLessThan(20_000);
    }
    // eslint-disable-next-line no-console
    console.log(`\n[stress] single-line first render: 2 MB ${timings["2 MB"]} ms, 8 MB ${timings["8 MB"]} ms`);
    expect(timings["8 MB"]).toBeLessThan(60_000);
    if (!STRICT) return;
    expect(timings["2 MB"]).toBeLessThan(1_500 * CI_SLACK);
    expect(timings["8 MB"]).toBeLessThan(4_000 * CI_SLACK);
    expect(timings["8 MB"]).toBeLessThanOrEqual(6 * timings["2 MB"] + 1_000);
  });
});
