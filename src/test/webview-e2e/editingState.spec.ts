import { expect, test, type Page } from "@playwright/test";
import { spliceText } from "../../core/csvEdit";
import { splitRecords } from "../../core/recordSpans";
import { utf8Length } from "../../core/csvSerialize";
import { awaitPosted, bootAndLoadText, clearPosted, defaultViewState, posted, postFromHost, pushLoadText } from "./harness";
import { toCsvText, wideFixture } from "./stress/stressHelpers";

const FILE_KEY = "file:///state.csv";
const TEXT = "id,name,city\r\n1,Alice,NYC\r\n2,Bob,LA\n3,Charlie,SF\r\n4,Dana,LA\r\n";

async function boot(page: Page, text = TEXT, state = defaultViewState(), extra: Partial<Parameters<typeof bootAndLoadText>[1]> = {}): Promise<void> {
  await bootAndLoadText(page, { fileKey: FILE_KEY, text, state, defaultTableColumns: 3, testHooks: true, hintsSeen: ["rowDetails"], ...extra });
}

const cell = (page: Page, rowId: number, columnIndex: number) =>
  page.locator(`tr.data-row[data-row-id="${rowId}"] td[data-column-index="${columnIndex}"]`);

async function edit(page: Page, rowId: number, columnIndex: number, value: string): Promise<void> {
  await cell(page, rowId, columnIndex).dblclick();
  await page.locator("input.cell-editor").fill(value);
  await page.keyboard.press("Enter");
  await expect(cell(page, rowId, columnIndex)).toHaveText(value);
}

const queryCount = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __workerQueryCount?: number }).__workerQueryCount ?? 0);

async function lastEdit(page: Page): Promise<Record<string, any>> {
  const edits = (await posted(page)).filter((m) => m.type === "edit");
  return edits[edits.length - 1] as Record<string, any>;
}

test.describe("marks and the unchanged view", () => {
  const bigText = toCsvText(["id", "name"], Array.from({ length: 80 }, (_, i) => [String(i), `person ${String(i).padStart(2, "0")}`]));

  test("marks survive paging away and back, sorting, filtering and hiding/showing the column", async ({ page }) => {
    await boot(page, bigText, defaultViewState({ pageSize: 25 }), { defaultTableColumns: 2 });
    await edit(page, 3, 1, "zzz edited");
    await expect(cell(page, 3, 1)).toHaveClass(/edited-cell/);

    await page.locator("#pager-next-btn").click();
    await expect(page.locator("#pager-page-input")).toHaveValue("2");
    await page.locator("#pager-prev-btn").click();
    await expect(cell(page, 3, 1)).toHaveClass(/edited-cell/);

    await page.locator("th", { hasText: "name" }).locator(".col-header-btn").click();
    await page.locator("th", { hasText: "name" }).locator(".col-header-btn").click();
    await expect(page.locator("tr.data-row").first().locator("td").nth(2)).toHaveText("zzz edited");
    await expect(cell(page, 3, 1)).toHaveClass(/edited-cell/);

    await page.locator("#quick-search").fill("zzz");
    await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 80 rows");
    await expect(cell(page, 3, 1)).toHaveClass(/edited-cell/);
    await page.locator("#quick-search").fill("");
    await expect(page.locator("#status-bar")).toHaveText("Showing 80 of 80 rows");

    await page.locator("#columns-btn").click();
    await page.locator(".column-row", { hasText: "name" }).locator("input").uncheck();
    await page.keyboard.press("Escape");
    await page.locator('tr.data-row[data-row-id="3"] .twisty').click();
    await expect(page.locator("#detail-row-3 dd.edited-field")).toHaveCount(1);
    await page.locator("#columns-btn").click();
    await page.locator(".column-row", { hasText: "name" }).locator("input").check();
    await expect(cell(page, 3, 1)).toHaveClass(/edited-cell/);
  });

  test("an edited row no longer matching the active search stays on its page until the search changes", async ({ page }) => {
    await boot(page, TEXT, defaultViewState({ quickSearch: "Alice" }));
    await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 4 rows");
    await edit(page, 0, 1, "Zed");
    await expect(page.locator("tr.data-row")).toHaveCount(1);
    await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 4 rows");

    await page.locator("#quick-search").fill("Alic");
    await expect(page.locator("#status-bar")).toHaveText("Showing 0 of 4 rows");
    await expect(page.locator("tr.data-row")).toHaveCount(0);
    await page.locator("#quick-search").fill("Zed");
    await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 4 rows");
  });

  test("toggling a rule off and on after an edit still re-queries, so the stale view is not served", async ({ page }) => {
    await boot(page, TEXT, defaultViewState({
      filterRules: [{ id: "r1", column: "name", operator: "contains", value: "Alice", mode: "include", caseSensitive: false, enabled: true }],
    }));
    await expect(page.locator("#status-bar")).toHaveText("Showing 1 of 4 rows");
    await edit(page, 0, 1, "Zed");
    await expect(page.locator("tr.data-row")).toHaveCount(1);

    const before = await queryCount(page);
    await page.locator("#filters-btn").click();
    const enabled = page.locator(".rule-row").first().locator('input[type="checkbox"]').first();
    await enabled.uncheck();
    await enabled.check();
    await expect(page.locator("#status-bar")).toHaveText("Showing 0 of 4 rows");
    expect(await queryCount(page)).toBeGreaterThan(before);
  });
});

test.describe("host-driven changes", () => {
  test("applyEdits (undo) restores the value and clears the mark, redo re-applies, and the worker follows", async ({ page }) => {
    await boot(page);
    await edit(page, 0, 1, "Zed");
    await postFromHost(page, { type: "applyEdits", baseVersion: 1, kind: "undo", cells: [{ rowId: 0, columnIndex: 1, value: "Alice", original: "Alice" }] });
    await expect(cell(page, 0, 1)).toHaveText("Alice");
    await expect(cell(page, 0, 1)).not.toHaveClass(/edited-cell/);
    await expect(page.locator("#edit-status")).toHaveText("Undone: name, row 1");

    await postFromHost(page, { type: "applyEdits", baseVersion: 1, kind: "redo", cells: [{ rowId: 0, columnIndex: 1, value: "Zed", original: "Alice" }] });
    await expect(cell(page, 0, 1)).toHaveText("Zed");
    await expect(cell(page, 0, 1)).toHaveClass(/edited-cell/);
    await expect(page.locator("#edit-status")).toHaveText("Redone: name, row 1");

    await page.locator("th", { hasText: "name" }).locator(".col-header-btn").click();
    await page.locator("th", { hasText: "name" }).locator(".col-header-btn").click();
    await expect(page.locator("tr.data-row").first().locator("td").nth(2)).toHaveText("Zed");
  });

  test("applyEdits for a different base is ignored", async ({ page }) => {
    await boot(page);
    await postFromHost(page, { type: "applyEdits", baseVersion: 7, cells: [{ rowId: 0, columnIndex: 1, value: "Nope", original: "Alice" }] });
    await page.waitForTimeout(200);
    await expect(cell(page, 0, 1)).toHaveText("Alice");
  });

  test("applyEdits can set a mark for a row that is not on the current page", async ({ page }) => {
    const text = toCsvText(["id", "name"], Array.from({ length: 60 }, (_, i) => [String(i), `p${i}`]));
    await boot(page, text, defaultViewState({ pageSize: 25 }), { defaultTableColumns: 2 });
    await postFromHost(page, { type: "applyEdits", baseVersion: 1, cells: [{ rowId: 40, columnIndex: 1, value: "changed", original: "p40" }] });
    await page.locator("#pager-next-btn").click();
    await expect(cell(page, 40, 1)).toHaveText("changed");
    await expect(cell(page, 40, 1)).toHaveClass(/edited-cell/);
  });

  test("saved clears every mark and posts synced; an edit to a later record then carries spans of the spliced text", async ({ page }) => {
    await boot(page);
    await edit(page, 0, 1, "Alexandria the Great");
    const first = await lastEdit(page);
    expect(first.change.record.originalText).toBe("1,Alice,NYC");

    await clearPosted(page);
    await postFromHost(page, { type: "saved", baseVersion: 2 });
    await expect(cell(page, 0, 1)).not.toHaveClass(/edited-cell/);
    expect(((await awaitPosted(page, "synced")) as { baseVersion: number }).baseVersion).toBe(2);
    await expect(page.locator("#edit-status")).toHaveText("All edits saved");

    const spans = splitRecords(TEXT, { delimiter: ",", quotes: true });
    const spliced = spliceText(TEXT, spans, [{ index: 1, fields: ["1", "Alexandria the Great", "NYC"] }], ",", true);
    const splicedSpans = splitRecords(spliced, { delimiter: ",", quotes: true });

    await clearPosted(page);
    await edit(page, 2, 1, "Charles");
    const next = await lastEdit(page);
    expect(next.baseVersion).toBe(2);
    expect(next.change.record.charStart).toBe(splicedSpans[3].start);
    expect(next.change.record.charEnd).toBe(splicedSpans[3].end);
    expect(next.change.record.byteStart).toBe(utf8Length(spliced, 0, splicedSpans[3].start));
    expect(next.change.record.byteEnd).toBe(utf8Length(spliced, 0, splicedSpans[3].end));
    expect(next.change.record.originalText).toBe("3,Charlie,SF");
  });

  test("a saved whose base is not the next one posts resync", async ({ page }) => {
    await boot(page);
    await clearPosted(page);
    await postFromHost(page, { type: "saved", baseVersion: 5 });
    await awaitPosted(page, "resync");
  });

  test("load with pendingEdits applies and marks them, and posts editsDropped for a record whose originalFields do not match", async ({ page }) => {
    await boot(page, TEXT, defaultViewState(), {
      pendingEdits: [
        { recordIndex: 1, originalFields: ["1", "Alice", "NYC"], fields: ["1", "Alicia", "NYC"] },
        { recordIndex: 3, originalFields: ["3", "NOT CHARLIE", "SF"], fields: ["3", "Chuck", "SF"] },
      ],
    });
    await expect(cell(page, 0, 1)).toHaveText("Alicia");
    await expect(cell(page, 0, 1)).toHaveClass(/edited-cell/);
    await expect(cell(page, 0, 1)).toHaveAttribute("title", "Edited (not saved). Original: Alice");
    await expect(cell(page, 2, 1)).toHaveText("Charlie");
    await expect(cell(page, 2, 1)).not.toHaveClass(/edited-cell/);
    const dropped = await awaitPosted(page, "editsDropped");
    expect(dropped.recordIndexes).toEqual([3]);
    await expect(page.locator("#edit-error-banner")).toBeVisible();
  });

  test("a regex-timeout worker respawn keeps edited values", async ({ page }) => {
    test.setTimeout(30_000);
    const rows: string[][] = [["0", "a".repeat(40) + "b"]];
    for (let i = 1; i < 60; i++) rows.push([String(i), `normal-${i}`]);
    await boot(page, toCsvText(["id", "val"], rows), defaultViewState(), { defaultTableColumns: 2 });
    await edit(page, 1, 1, "EDITED");

    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("val");
    await rule.locator('select[aria-label="Condition"]').selectOption("regex");
    await rule.locator('input[type="text"]').fill("(a+)+$");
    await expect(rule.locator(".rule-error-text")).toHaveText("Skipped: pattern took over 2 s. Edit it to retry.", { timeout: 6_000 });

    await expect(cell(page, 1, 1)).toHaveText("EDITED");
    await expect(cell(page, 1, 1)).toHaveClass(/edited-cell/);
  });
});

test.describe("flush, lock and load", () => {
  test("flushEdits while an editor is open commits it, and flushed follows the edit", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).dblclick();
    await page.locator("input.cell-editor").fill("Flushed");
    await clearPosted(page);
    await postFromHost(page, { type: "flushEdits", baseVersion: 1 });
    await awaitPosted(page, "flushed");
    const types = (await posted(page)).map((m) => m.type);
    expect(types.indexOf("edit")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("edit")).toBeLessThan(types.indexOf("flushed"));
    expect(((await awaitPosted(page, "flushed")) as { baseVersion: number }).baseVersion).toBe(1);
  });

  test("Ctrl+S commits an open editor synchronously", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).dblclick();
    await page.locator("input.cell-editor").fill("Saved");
    await clearPosted(page);
    await page.keyboard.press("Control+s");
    await expect(page.locator("input.cell-editor")).toHaveCount(0);
    await awaitPosted(page, "edit");
  });

  test("flushed is posted even when nothing is open", async ({ page }) => {
    await boot(page);
    await clearPosted(page);
    await postFromHost(page, { type: "flushEdits", baseVersion: 1 });
    await awaitPosted(page, "flushed");
  });

  test("the File format controls and the quote banner button are disabled while dirty and enabled after saved", async ({ page }) => {
    await boot(page);
    await page.locator("#format-btn").click();
    await expect(page.locator("#separator-select")).toBeEnabled();
    await page.keyboard.press("Escape");
    await edit(page, 0, 1, "Dirty");
    await page.locator("#format-btn").click();
    for (const selector of ["#separator-select", "#separator-custom", "#first-row-header", "#quotes-checkbox"]) {
      await expect(page.locator(selector)).toBeDisabled();
    }
    await expect(page.locator("#quote-warning-fix-btn")).toBeDisabled();
    await expect(page.locator("#format-locked-note")).toHaveText("Save or revert your edits to change the file format.");
    await expect(page.locator("#separator-select")).toHaveAttribute("title", "Save or revert your edits to change the file format.");

    await postFromHost(page, { type: "saved", baseVersion: 2 });
    await expect(page.locator("#separator-select")).toBeEnabled();
    await expect(page.locator("#format-locked-note")).toBeHidden();
  });

  test("controls unlock when every edit is undone", async ({ page }) => {
    await boot(page);
    await edit(page, 0, 1, "Dirty");
    await postFromHost(page, { type: "applyEdits", baseVersion: 1, kind: "undo", cells: [{ rowId: 0, columnIndex: 1, value: "Alice", original: "Alice" }] });
    await page.locator("#format-btn").click();
    await expect(page.locator("#quotes-checkbox")).toBeEnabled();
  });

  test("a load cancels an open editor and clears the marks", async ({ page }) => {
    await boot(page);
    await edit(page, 1, 1, "Marked");
    await cell(page, 0, 1).dblclick();
    await page.locator("input.cell-editor").fill("Unfinished");
    await clearPosted(page);
    await pushLoadText(page, { fileKey: FILE_KEY, text: TEXT, state: defaultViewState(), defaultTableColumns: 3, baseVersion: 2 });
    await expect(page.locator("input.cell-editor")).toHaveCount(0);
    await expect(cell(page, 0, 1)).toHaveText("Alice");
    await expect(cell(page, 1, 1)).toHaveText("Bob");
    await expect(page.locator(".edited-cell")).toHaveCount(0);
    expect((await posted(page)).filter((m) => m.type === "edit")).toHaveLength(0);
  });

  test("the changed-on-disk banner offers Discard Edits and Reload, posts revert, and the next load hides it", async ({ page }) => {
    await boot(page);
    await postFromHost(page, { type: "fileChangedOnDisk", name: "state.csv" });
    await expect(page.locator("#file-changed-banner")).toBeVisible();
    await expect(page.locator("#file-changed-text")).toHaveText('"state.csv" changed on disk. Your unsaved edits are kept; saving will ask before overwriting.');
    await expect(page.locator("#file-changed-banner button")).toHaveText("Discard Edits and Reload");
    await clearPosted(page);
    await page.locator("#file-changed-revert-btn").click();
    await awaitPosted(page, "revert");
    await pushLoadText(page, { fileKey: FILE_KEY, text: TEXT, state: defaultViewState(), defaultTableColumns: 3, baseVersion: 2 });
    await expect(page.locator("#file-changed-banner")).toBeHidden();
  });

  test("the deleted-file banner says edits are kept while dirty", async ({ page }) => {
    await boot(page);
    await edit(page, 0, 1, "Dirty");
    await postFromHost(page, { type: "fileDeleted", name: "state.csv" });
    await expect(page.locator("#file-deleted-text")).toHaveText('"state.csv" was deleted from disk. Your unsaved edits are kept; saving will recreate the file.');
  });

  test("dismissing the edit-error banner hides it, and the next successful commit hides it too", async ({ page }) => {
    await boot(page, "name\nalpha\nbeta\n", defaultViewState(), { defaultTableColumns: 1 });
    await cell(page, 0, 0).dblclick();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Enter");
    await expect(page.locator("#edit-error-banner")).toBeVisible();
    await page.locator("#edit-error-dismiss-btn").click();
    await expect(page.locator("#edit-error-banner")).toBeHidden();

    await cell(page, 0, 0).dblclick();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Enter");
    await expect(page.locator("#edit-error-banner")).toBeVisible();
    await edit(page, 1, 0, "gamma");
    await expect(page.locator("#edit-error-banner")).toBeHidden();
  });

  test("padded cells: editing a missing trailing field is allowed and posts a record with the original field count", async ({ page }) => {
    await boot(page, "a,b,c\n1,2\n", defaultViewState(), { defaultTableColumns: 3 });
    await edit(page, 0, 2, "x");
    const change = (await lastEdit(page)).change;
    expect(change.record.fieldCount).toBe(2);
    expect(change.record.originalFields).toEqual(["1", "2"]);
    expect(change.columnIndex).toBe(2);
  });

  test("with 'First row is header' off, the first record is an ordinary editable row", async ({ page }) => {
    await boot(page, "x,y\n1,2\n", defaultViewState({ firstRowIsHeader: false }), { defaultTableColumns: 2 });
    await edit(page, 0, 0, "X");
    const change = (await lastEdit(page)).change;
    expect(change.recordIndex).toBe(0);
    expect(change.rowId).toBe(0);
  });

  test("wide fixtures keep their column indexes: edits address the file's column, not the visible position", async ({ page }) => {
    const fixture = wideFixture(5, 6);
    await boot(page, toCsvText(fixture.headers, fixture.rows), defaultViewState({ columnVisibility: { col_1: false, col_2: true, col_3: false, col_4: true, col_5: false, col_6: false } }), { defaultTableColumns: 2 });
    await edit(page, 2, 3, "changed");
    expect((await lastEdit(page)).change.columnIndex).toBe(3);
    expect((await lastEdit(page)).change.column).toBe("col_4");
  });
});
