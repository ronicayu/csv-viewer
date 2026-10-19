import { expect, test, type Page } from "@playwright/test";
import { utf8Length } from "../../core/csvSerialize";
import { awaitPosted, bootShell, clearPosted, defaultViewState, postFromHost, posted, pushLoadText } from "./harness";

// A file of 4,000 rows cut into slices of 500 records with a pause between them, so for about three seconds only part of it has been parsed
// (generous, because a loaded machine must still find the parse unfinished when the test acts).
const ROWS = 4000;
const TUNING = { sliceRecords: 500, sliceDelayMs: 400 };
const FILE_KEY = "file:///progressive.csv";

const row = (i: number): string => `${i},${i % 100 === 0 ? "namé" : "name"}${i},g${i % 20},${(i * 7) % 1000}`;
const fileText = (rows = ROWS): string => ["id,name,group,score", ...Array.from({ length: rows }, (_, i) => row(i))].join("\n") + "\n";

async function load(page: Page, text = fileText(), tuning: { sliceRecords?: number; sliceDelayMs?: number } | undefined = TUNING): Promise<void> {
  await bootShell(page, { parseTuning: tuning });
  await pushLoadText(page, { fileKey: FILE_KEY, text, state: defaultViewState(), defaultTableColumns: 8, testHooks: true });
}

const status = (page: Page) => page.locator("#status-bar");
const queriesSent = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __workerQueryCount?: number }).__workerQueryCount ?? 0);
const cell = (page: Page, rowId: number, columnIndex: number) => page.locator(`tr.data-row[data-row-id="${rowId}"] td[data-column-index="${columnIndex}"]`);

test.describe("a file that is still being parsed", () => {
  test("shows its first page before it knows how many rows there are, and asks the worker for nothing else", async ({ page }) => {
    await load(page);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(status(page)).toHaveText(/^Showing the first \d+ rows; loading the rest…$/);
    await expect(page.locator("#pager-page-count")).toHaveText("…");
    await expect(page.locator("#pager-row-range")).toHaveText("1–100 of … rows (loading)");
    for (const id of ["#pager-first-btn", "#pager-prev-btn", "#pager-next-btn", "#pager-last-btn", "#pager-page-input"]) await expect(page.locator(id)).toBeDisabled();
    await expect(page.locator("#pager-page-size-select")).toBeEnabled();
    expect(await queriesSent(page)).toBe(0);
    expect((await posted(page)).filter((m) => m.type === "rendered")).toHaveLength(0);

    await expect(status(page)).toHaveText("Showing 4,000 of 4,000 rows", { timeout: 30_000 });
    await expect(page.locator("#pager-page-count")).toHaveText("40");
    await expect(page.locator("#pager-row-range")).toHaveText("1–100 of 4,000 rows");
    await expect(page.locator("#pager-next-btn")).toBeEnabled();
    expect(await queriesSent(page)).toBe(0);
    const rendered = (await posted(page)).filter((m) => m.type === "rendered") as Array<{ rowCount: number; headers: string[] }>;
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ rowCount: 4000, headers: ["id", "name", "group", "score"] });

    await page.locator("#pager-next-btn").click();
    await expect(cell(page, 100, 1)).toHaveText("namé100");
  });

  test("a sort asked for mid-parse is answered over every row", async ({ page }) => {
    await load(page);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-count")).toHaveText("…");
    await page.locator("th", { hasText: "score" }).click();
    await page.locator("th", { hasText: "score" }).click();
    await expect(status(page)).toHaveText("Showing 4,000 of 4,000 rows", { timeout: 30_000 });
    await expect(page.locator("th", { hasText: "score" })).toHaveAttribute("aria-sort", "descending");
    await expect(page.locator("#pager-page-count")).toHaveText("40");
    // 999 is the largest score and (i * 7) % 1000 == 999 first at i == 857.
    await expect(cell(page, 857, 3)).toHaveText("999");
    await expect(page.locator("tr.data-row").first()).toHaveAttribute("data-row-id", "857");
  });

  test("a search asked for mid-parse counts matches in the rows that had not been parsed", async ({ page }) => {
    await load(page);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await page.locator("#quick-search").fill("name39");
    // name39, name390–399 and name3900–3999, except that rows 3900 and the like are "namé…".
    await expect(status(page)).toHaveText("Showing 110 of 4,000 rows", { timeout: 30_000 });
    await expect(page.locator("#pager-row-range")).toHaveText("1–100 of 110 rows (filtered from 4,000)");
  });

  test("a ragged file gains its columns once the wide row is parsed, and the columns list and the rows follow", async ({ page }) => {
    const text = fileText(1200) + "1200,name1200,g0,7,extra,more\n";
    await load(page, text, { sliceRecords: 300, sliceDelayMs: 600 });
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#columns-btn")).toHaveText("Columns 4/4");
    await page.locator("#columns-btn").click();
    await expect(page.locator("#columns-list label.column-row")).toHaveCount(4);

    await expect(page.locator("#columns-btn")).toHaveText("Columns 6/6", { timeout: 30_000 });
    await expect(page.locator("#columns-list label.column-row")).toHaveCount(6);
    await expect(page.locator("#columns-list label.column-row").nth(5)).toHaveText("column_6");
    await page.locator("#columns-btn").click();
    await expect(page.locator("th.sortable")).toHaveCount(6);
    await expect(page.locator("tr.data-row").first().locator("td")).toHaveCount(7);
    await expect(status(page)).toHaveText("Showing 1,201 of 1,201 rows");
  });

  test("an edit made before the parse is done lands on its record, and a save after it keeps byte offsets exact", async ({ page }) => {
    await load(page);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-count")).toHaveText("…");
    await cell(page, 3, 1).dblclick();
    await page.locator("input.cell-editor").fill("édited");
    await clearPosted(page);
    await page.keyboard.press("Enter");
    const edit = (await awaitPosted(page, "edit")).change as Record<string, any>;
    expect(edit).toMatchObject({ rowId: 3, recordIndex: 4, columnIndex: 1, oldValue: "name3", newValue: "édited" });
    const text = fileText();
    const start = text.indexOf("\n3,name3") + 1;
    expect(edit.record.charStart).toBe(start);
    expect(edit.record.byteStart).toBe(utf8Length(text, 0, start));

    await expect(status(page)).toHaveText("Showing 4,000 of 4,000 rows", { timeout: 30_000 });
    await expect(cell(page, 3, 1)).toHaveText("édited");
    await expect(cell(page, 3, 1)).toHaveClass(/edited-cell/);

    // The host writes the record; the next edit must see the patched text and bytes.
    await postFromHost(page, { type: "saved", baseVersion: 2, written: [{ recordIndex: 4, fields: ["3", "édited", "g3", "21"] }] });
    await cell(page, 5, 1).dblclick();
    await page.locator("input.cell-editor").fill("x");
    await clearPosted(page);
    await page.keyboard.press("Enter");
    const next = (await awaitPosted(page, "edit")).change as Record<string, any>;
    const patched = text.replace("\n3,name3,g3,21\n", "\n3,édited,g3,21\n");
    const nextStart = patched.indexOf("\n5,name5") + 1;
    expect(next.record.charStart).toBe(nextStart);
    expect(next.record.byteStart).toBe(utf8Length(patched, 0, nextStart));
  });

  test("flushEdits after a mid-parse edit waits for it and is answered", async ({ page }) => {
    await load(page);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-count")).toHaveText("…");
    await cell(page, 2, 1).dblclick();
    await page.locator("input.cell-editor").fill("flushed");
    await page.keyboard.press("Enter");
    await postFromHost(page, { type: "flushEdits", baseVersion: 1 });
    await awaitPosted(page, "flushed");
    // The edit reaches the host before the flush is answered.
    const kinds = (await posted(page)).map((m) => m.type).filter((type) => type === "edit" || type === "flushed");
    expect(kinds).toEqual(["edit", "flushed"]);
    await expect(status(page)).toHaveText("Showing 4,000 of 4,000 rows", { timeout: 30_000 });
    await expect(cell(page, 2, 1)).toHaveText("flushed");
  });

  test("a catastrophic regex asked for mid-parse finishes the parse, times out, and the respawned worker parses again from the kept bytes", async ({ page }) => {
    const rows = Array.from({ length: 3000 }, (_, i) => (i === 0 ? `0,${"a".repeat(40)}b` : `${i},normal-${i}`));
    await load(page, ["id,val", ...rows].join("\n") + "\n", { sliceRecords: 500, sliceDelayMs: 600 });
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-count")).toHaveText("…");
    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("val");
    await rule.locator('select[aria-label="Condition"]').selectOption("regex");
    await rule.locator('input[type="text"]').fill("(a+)+$");
    await expect(rule.locator(".rule-error-text")).toHaveText("Skipped: pattern took over 2 s. Edit it to retry.", { timeout: 30_000 });
    await expect(status(page)).toHaveText("Showing 3,000 of 3,000 rows", { timeout: 30_000 });
    await expect(page.locator("tr.data-row")).toHaveCount(100);
  });

  test("a wide file that gains columns past the cap keeps the capped lists in step", async ({ page }) => {
    test.setTimeout(90_000);
    await bootShell(page, { parseTuning: { sliceRecords: 400, sliceDelayMs: 800 } });
    const text = await page.evaluate(() => {
      const header = Array.from({ length: 1100 }, (_, i) => `h${i + 1}`).join(",");
      const row = Array.from({ length: 1100 }, (_, i) => `v${i + 1}`).join(",");
      const wide = Array.from({ length: 1250 }, (_, i) => `w${i + 1}`).join(",");
      return `${header}\n${Array.from({ length: 1500 }, () => row).join("\n")}\n${wide}\n`;
    });
    await pushLoadText(page, { fileKey: FILE_KEY, text, state: defaultViewState(), defaultTableColumns: 8, testHooks: true });
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#columns-btn")).toHaveText("Columns 8/1100");
    await page.locator("#columns-btn").click();
    await expect(page.locator("#columns-list .column-row-more")).toHaveText("Showing 1,000 of 1,100 columns — type to narrow");

    await expect(page.locator("#columns-btn")).toHaveText("Columns 8/1250", { timeout: 30_000 });
    await expect(page.locator("#columns-list .column-row-more")).toHaveText("Showing 1,000 of 1,250 columns — type to narrow");
    await expect(status(page)).toHaveText("Showing 1,501 of 1,501 rows");
  });

  test("the values picker opened mid-parse lists the values of every row", async ({ page }) => {
    await load(page);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-count")).toHaveText("…");
    await page.locator('th[data-column="id"] .col-filter-btn').click();
    await expect(page.locator("#values-selected-count")).toHaveText("4000 of 4000 selected", { timeout: 30_000 });
  });

  test("a load that arrives mid-parse replaces the file, and the old parse leaves nothing behind", async ({ page }) => {
    await load(page);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-count")).toHaveText("…");
    await pushLoadText(page, { fileKey: "file:///other.csv", text: "k,v\na,1\nb,2\nc,3\n", state: defaultViewState(), defaultTableColumns: 8, testHooks: true });
    await expect(status(page)).toHaveText("Showing 3 of 3 rows");
    await page.waitForTimeout(3000);
    await expect(status(page)).toHaveText("Showing 3 of 3 rows");
    await expect(page.locator("tr.data-row")).toHaveCount(3);
    await expect(page.locator("#pager-page-count")).toHaveText("1");
    await expect(page.locator("#columns-btn")).toHaveText("Columns 2/2");
  });

  test("a separator change mid-parse re-parses the file the worker holds", async ({ page }) => {
    await load(page);
    await expect(page.locator("tr.data-row")).toHaveCount(100);
    await expect(page.locator("#pager-page-count")).toHaveText("…");
    await page.locator("#format-btn").click();
    await page.locator("#separator-select").selectOption(";");
    await expect(page.locator("th.sortable")).toHaveCount(1);
    await expect(status(page)).toHaveText("Showing 4,000 of 4,000 rows", { timeout: 30_000 });
    await page.locator("#separator-select").selectOption(",");
    await expect(page.locator("th.sortable")).toHaveCount(4);
    await expect(status(page)).toHaveText("Showing 4,000 of 4,000 rows", { timeout: 30_000 });
    await expect(cell(page, 0, 3)).toHaveText("0");
  });

  test("a file parsed in one slice behaves as before: a query and a page, no waiting", async ({ page }) => {
    await load(page, fileText(60), undefined);
    await expect(status(page)).toHaveText("Showing 60 of 60 rows");
    await expect(page.locator("#pager-page-count")).toHaveText("1");
    expect(await queriesSent(page)).toBe(1);
  });

  test("a regex that times out, after a progressive load, respawns the worker from the bytes the page kept", async ({ page }) => {
    const rows = Array.from({ length: 3000 }, (_, i) => (i === 0 ? `0,${"a".repeat(40)}b` : `${i},normal-${i}`));
    await load(page, ["id,val", ...rows].join("\n") + "\n", { sliceRecords: 500 });
    await expect(status(page)).toHaveText("Showing 3,000 of 3,000 rows", { timeout: 30_000 });
    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("val");
    await rule.locator('select[aria-label="Condition"]').selectOption("regex");
    await rule.locator('input[type="text"]').fill("(a+)+$");
    await expect(rule.locator(".rule-error-text")).toHaveText("Skipped: pattern took over 2 s. Edit it to retry.", { timeout: 10_000 });
    await expect(status(page)).toHaveText("Showing 3,000 of 3,000 rows", { timeout: 30_000 });
    await expect(page.locator("tr.data-row").first()).toContainText("aaaa");
  });
});
