import { expect, test, type Page } from "@playwright/test";
import { bootAndLoad, bootAndLoadText, bootShell, defaultViewState, postFromHost } from "../harness";
import { toCsvText, trackConsoleErrors } from "./stressHelpers";

const STRICT = process.env.PERF_TESTS === "1";
const CI_SLACK = process.env.CI ? 2 : 1;
const COMMIT_BOUND_MS = STRICT ? 100 * CI_SLACK : 2_000;
const EDIT_MESSAGE_BOUND_MS = STRICT ? 200 * CI_SLACK : 5_000;
const PAGE_BOUND_MS = STRICT ? 2_000 * CI_SLACK : 30_000;

const cell = (page: Page, rowId: number, columnIndex: number) =>
  page.locator(`tr.data-row[data-row-id="${rowId}"] td[data-column-index="${columnIndex}"]`);

test("200k x 30: a commit updates its cell within 100 ms and the edit message follows within 200 ms", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = trackConsoleErrors(page);
  await bootShell(page);
  await page.evaluate(() => {
    const headers: string[] = [];
    for (let i = 0; i < 30; i++) headers.push(`col_${i + 1}`);
    const lines: string[] = [headers.join(",")];
    for (let r = 0; r < 200_000; r++) {
      const cells: string[] = [];
      for (let c = 0; c < 30; c++) cells.push(c === 0 ? String(r) : `v${r}_${c}`);
      lines.push(cells.join(","));
    }
    window.postMessage(
      {
        type: "load",
        fileKey: "file:///edit-scale.csv",
        text: lines.join("\n"),
        state: { columnVisibility: {}, filterRules: [], quickSearch: "", sortKeys: [], firstRowIsHeader: true, pageSize: 100, delimiter: "", quotes: true, markdownColumns: {} },
        defaultTableColumns: 8,
        defaultDelimiter: "",
        hintsSeen: ["rowDetails"],
        baseVersion: 1,
        editable: true,
        pendingEdits: [],
      },
      "*",
    );
  });
  await expect(page.locator("tr.data-row").first()).toBeVisible({ timeout: 60_000 });

  await cell(page, 5, 1).dblclick();
  const input = page.locator("input.cell-editor");
  await input.fill("edited value");

  const timings = await page.evaluate(() => {
    const posted = (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted;
    const originalPush = posted.push.bind(posted);
    let editAt = -1;
    posted.push = (...items: Array<Record<string, unknown>>) => {
      if (items.some((m) => m.type === "edit")) editAt = performance.now();
      return originalPush(...items);
    };
    const field = document.querySelector<HTMLInputElement>("input.cell-editor")!;
    const start = performance.now();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const cellMs = performance.now() - start;
    const shown = document.querySelector('tr.data-row[data-row-id="5"] td[data-column-index="1"]')!.textContent;
    return new Promise<{ cellMs: number; shown: string | null; editMs: number }>((resolve) => {
      const poll = (): void => {
        if (editAt >= 0) resolve({ cellMs, shown, editMs: editAt - start });
        else setTimeout(poll, 2);
      };
      poll();
    });
  });
  // eslint-disable-next-line no-console
  console.log(`[stress] 200k x 30 edit: cell updated in ${timings.cellMs.toFixed(1)}ms, edit message after ${timings.editMs.toFixed(1)}ms`);
  expect(timings.shown).toBe("edited value");
  expect(timings.cellMs).toBeLessThan(COMMIT_BOUND_MS);
  expect(timings.editMs).toBeLessThan(EDIT_MESSAGE_BOUND_MS);
  expect(consoleErrors).toEqual([]);
});

test("a 500-character cell edits inline and a 501-character one redirects to the details", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///boundary.csv",
    headers: ["id", "note"],
    rows: [
      ["1", "x".repeat(500)],
      ["2", "y".repeat(501)],
    ],
    state: defaultViewState({ columnVisibility: { id: true, note: true } }),
    defaultTableColumns: 2,
  });
  await cell(page, 0, 1).dblclick();
  await expect(page.locator("input.cell-editor")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await cell(page, 1, 1).dblclick();
  await expect(page.locator("input.cell-editor")).toHaveCount(0);
  await expect(page.locator("textarea.field-editor")).toHaveCount(1);
});

test("a 2 MB cell is refused in both editors", async ({ page }) => {
  await bootAndLoad(page, {
    fileKey: "file:///huge.csv",
    headers: ["id", "note"],
    rows: [["1", "z".repeat(2 * 1024 * 1024)]],
    state: defaultViewState({ columnVisibility: { id: true, note: true } }),
    defaultTableColumns: 2,
  });
  await cell(page, 0, 1).dblclick();
  await expect(page.locator("#edit-error-banner")).toBeVisible();
  await page.locator("#edit-error-dismiss-btn").click();
  await page.locator('tr.data-row[data-row-id="0"] .twisty').click();
  await expect(page.locator(".field-edit-btn").first()).toBeDisabled();
  await expect(page.locator("input.cell-editor, textarea.field-editor")).toHaveCount(0);
});

test("columns named __proto__ and constructor edit like any other", async ({ page }) => {
  await bootAndLoadText(page, {
    fileKey: "file:///proto.csv",
    text: toCsvText(["__proto__", "constructor", "id"], [["a", "b", "1"], ["c", "d", "2"]]),
    state: defaultViewState(),
    defaultTableColumns: 3,
    testHooks: true,
  });
  await cell(page, 0, 0).dblclick();
  await page.keyboard.type("polluted?");
  await page.keyboard.press("Enter");
  await cell(page, 1, 1).dblclick();
  await page.keyboard.type("also fine");
  await page.keyboard.press("Enter");
  await expect(cell(page, 0, 0)).toHaveText("polluted?");
  await expect(cell(page, 1, 1)).toHaveText("also fine");
  await expect(cell(page, 0, 0)).toHaveClass(/edited-cell/);
  expect(await page.evaluate(() => ({} as Record<string, unknown>).polluted)).toBeUndefined();

  await page.locator("th", { hasText: "__proto__" }).locator(".col-header-btn").click();
  await expect(page.locator("tr.data-row").first().locator("td").nth(1)).toHaveText("c");
});

test("500 edits on one page keep the page re-render within the scale spec's page target", async ({ page }) => {
  test.setTimeout(120_000);
  const rows = Array.from({ length: 1000 }, (_, i) => [String(i), `name ${i}`, `city ${i % 10}`]);
  await bootAndLoadText(page, {
    fileKey: "file:///many-edits.csv",
    text: toCsvText(["id", "name", "city"], rows),
    state: defaultViewState({ pageSize: 500 }),
    defaultTableColumns: 3,
    testHooks: true,
  });
  await expect(page.locator("tr.data-row")).toHaveCount(500);
  for (let i = 0; i < 500; i++) {
    await postFromHost(page, { type: "testEditCell", rowId: i, columnIndex: 1, value: `edited ${i}` });
  }
  await expect(page.locator(".edited-cell")).toHaveCount(500, { timeout: 60_000 });

  const start = Date.now();
  await page.locator("#pager-next-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("2");
  await page.locator("#pager-prev-btn").click();
  await expect(page.locator("#pager-page-input")).toHaveValue("1");
  await expect(page.locator(".edited-cell")).toHaveCount(500);
  const ms = Date.now() - start;
  // eslint-disable-next-line no-console
  console.log(`[stress] paging away and back over 500 edited rows: ${ms}ms`);
  expect(ms).toBeLessThan(PAGE_BOUND_MS);
});
