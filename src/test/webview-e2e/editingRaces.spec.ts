import { expect, test, type Page } from "@playwright/test";
import { awaitPosted, bootAndLoadText, clearPosted, defaultViewState, posted, postFromHost } from "./harness";
import { toCsvText } from "./stress/stressHelpers";

const FILE_KEY = "file:///races.csv";

async function boot(page: Page, text: string, extra: Partial<Parameters<typeof bootAndLoadText>[1]> = {}): Promise<void> {
  await bootAndLoadText(page, { fileKey: FILE_KEY, text, state: defaultViewState(), defaultTableColumns: 3, testHooks: true, hintsSeen: ["rowDetails"], ...extra });
}

const cell = (page: Page, rowId: number, columnIndex: number) =>
  page.locator(`tr.data-row[data-row-id="${rowId}"] td[data-column-index="${columnIndex}"]`);

async function edit(page: Page, rowId: number, columnIndex: number, value: string): Promise<void> {
  await cell(page, rowId, columnIndex).dblclick();
  await page.locator("input.cell-editor").fill(value);
  await page.keyboard.press("Enter");
  await expect(cell(page, rowId, columnIndex)).toHaveText(value);
  await expect(cell(page, rowId, columnIndex)).toHaveClass(/edited-cell/);
}

test.describe("save, undo and new edits close together", () => {
  test("an undo that follows `saved` at once is applied, and marks the cell against what was saved", async ({ page }) => {
    await boot(page, "id,name\n1,Alice\n2,Bob\n");
    await edit(page, 0, 1, "Zed");
    await clearPosted(page);
    await page.evaluate(() => {
      window.postMessage({ type: "saved", baseVersion: 2, written: [{ recordIndex: 1, fields: ["1", "Zed"] }] }, "*");
      window.postMessage({ type: "applyEdits", baseVersion: 2, kind: "undo", cells: [{ rowId: 0, columnIndex: 1, value: "Alice", original: "Zed" }] }, "*");
    });
    await awaitPosted(page, "synced");
    await expect(cell(page, 0, 1)).toHaveText("Alice");
    await expect(cell(page, 0, 1)).toHaveClass(/edited-cell/);
    await expect(cell(page, 0, 1)).toHaveAttribute("title", "Edited (not saved). Original: Zed");
  });

  test("a cell edited after the host took its snapshot stays an edit once `saved` arrives", async ({ page }) => {
    await boot(page, "id,name,city\n1,Alice,NYC\n2,Bob,LA\n");
    await edit(page, 0, 1, "Alicia");
    await edit(page, 0, 2, "Boston");
    await postFromHost(page, { type: "saved", baseVersion: 2, written: [{ recordIndex: 1, fields: ["1", "Alicia", "NYC"] }] });
    await awaitPosted(page, "synced");
    await expect(cell(page, 0, 1)).not.toHaveClass(/edited-cell/);
    await expect(cell(page, 0, 2)).toHaveClass(/edited-cell/);
    await expect(cell(page, 0, 2)).toHaveAttribute("title", "Edited (not saved). Original: NYC");

    // and the next edit of that record is made against the written text
    await clearPosted(page);
    await edit(page, 0, 1, "Ali");
    const edits = (await posted(page)).filter((m) => m.type === "edit") as unknown as Array<{ baseVersion: number; change: { record: { originalText: string; originalFields: string[] } } }>;
    expect(edits[0].baseVersion).toBe(2);
    expect(edits[0].change.record.originalText).toBe("1,Alicia,NYC");
    expect(edits[0].change.record.originalFields).toEqual(["1", "Alicia", "NYC"]);
  });

  test("an edit still in the worker when `saved` lands is reported against the base it was made on", async ({ page }) => {
    await boot(page, "id,name\n1,Alice\n2,Bob\n");
    await clearPosted(page);
    await page.evaluate(() => {
      const input = (document.querySelector('tr.data-row[data-row-id="1"] td[data-column-index="1"]') as HTMLElement);
      input.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const editor = document.querySelector<HTMLInputElement>("input.cell-editor")!;
      editor.value = "Robert";
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      window.postMessage({ type: "saved", baseVersion: 2, written: [] }, "*");
    });
    await awaitPosted(page, "edit");
    const sent = (await posted(page)).find((m) => m.type === "edit") as unknown as { baseVersion: number };
    expect(sent.baseVersion).toBe(1);
  });

  test("a worker replaced while an undo is waiting for it still applies the undo", async ({ page }) => {
    test.setTimeout(30_000);
    const rows: string[][] = [["0", "a".repeat(40) + "b"]];
    for (let i = 1; i < 30; i++) rows.push([String(i), `normal-${i}`]);
    await boot(page, toCsvText(["id", "val"], rows), { defaultTableColumns: 2 });
    await edit(page, 1, 1, "EDITED");

    await page.locator("#filters-btn").click();
    await page.locator("#add-rule-btn").click();
    const rule = page.locator(".rule-row").first();
    await rule.locator('select[aria-label="Column"]').selectOption("val");
    await rule.locator('select[aria-label="Condition"]').selectOption("regex");
    await rule.locator('input[type="text"]').fill("(a+)+$");
    // The worker is now stuck in the regex, so this waits in its queue and is lost when it is replaced.
    await page.waitForTimeout(400);
    await postFromHost(page, { type: "applyEdits", baseVersion: 1, kind: "redo", cells: [{ rowId: 2, columnIndex: 1, value: "LATE", original: "normal-2" }] });
    await expect(rule.locator(".rule-error-text")).toHaveText("Skipped: pattern took over 2 s. Edit it to retry.", { timeout: 8_000 });

    await expect(cell(page, 2, 1)).toHaveText("LATE");
    await expect(cell(page, 2, 1)).toHaveClass(/edited-cell/);
    await expect(cell(page, 1, 1)).toHaveText("EDITED");
  });
});

test.describe("the file format stays locked around edits", () => {
  test("the separator error's Turn Off link is disabled while dirty, and does nothing if clicked anyway", async ({ page }) => {
    await boot(page, 'id,name\n1,"Al,ice"\n2,Bob\n', { defaultTableColumns: 2 });
    await page.locator("#format-btn").click();
    await page.locator("#separator-select").selectOption({ label: "Custom…" });
    await page.locator("#separator-custom").fill('"');
    await expect(page.locator("#separator-custom-error")).toContainText("Can't use");
    await page.keyboard.press("Escape");
    await edit(page, 1, 1, "Robert");

    await page.locator("#format-btn").click();
    const turnOff = page.locator("#separator-custom-error button");
    await expect(turnOff).toBeDisabled();
    await clearPosted(page);
    await turnOff.click({ force: true });
    await page.waitForTimeout(400);
    await expect(page.locator("#quotes-checkbox")).toBeChecked();
    expect((await posted(page)).filter((m) => m.type === "saveState")).toHaveLength(0);
    await expect(cell(page, 1, 1)).toHaveText("Robert");
  });

  test("a pending custom-separator debounce does not re-tokenize once an edit has been committed", async ({ page }) => {
    await boot(page, "id,name\n1,Alice\n2,Bob\n", { defaultTableColumns: 2 });
    await page.locator("#format-btn").click();
    await page.locator("#separator-select").selectOption({ label: "Custom…" });
    await page.locator("#separator-custom").fill(";");
    // The debounce is still pending; commit an edit first.
    await page.evaluate(() => {
      document.querySelector('tr.data-row[data-row-id="1"] td[data-column-index="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const editor = document.querySelector<HTMLInputElement>("input.cell-editor")!;
      editor.value = "Robert";
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(600);
    await expect(page.locator("th.sortable")).toHaveCount(2);
    await expect(cell(page, 1, 1)).toHaveText("Robert");
  });

  test("the controls lock the instant an edit is committed, before the worker has answered", async ({ page }) => {
    await boot(page, "id,name\n1,Alice\n2,Bob\n", { defaultTableColumns: 2 });
    const lockedAtOnce = await page.evaluate(() => {
      document.querySelector('tr.data-row[data-row-id="1"] td[data-column-index="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const editor = document.querySelector<HTMLInputElement>("input.cell-editor")!;
      editor.value = "Robert";
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return (document.getElementById("quotes-checkbox") as HTMLInputElement).disabled;
    });
    expect(lockedAtOnce).toBe(true);
  });

  test("the first edit pins the detected separator, saved before the edit is reported", async ({ page }) => {
    await boot(page, "a\nx\ny\n", { defaultTableColumns: 1 });
    await page.locator("#format-btn").click();
    await expect(page.locator("#separator-select option:checked")).toHaveText("Auto (,)");
    await page.keyboard.press("Escape");
    await clearPosted(page);
    await edit(page, 0, 0, "q|r");
    await page.locator("#format-btn").click();
    await expect(page.locator("#separator-select option:checked")).toHaveText("Comma (,)");
    const types = (await posted(page)).filter((m) => m.type === "saveState" || m.type === "edit").map((m) => m.type);
    expect(types).toEqual(["saveState", "edit"]);
    const state = ((await posted(page)).find((m) => m.type === "saveState") as unknown as { state: { delimiter: string } }).state;
    expect(state.delimiter).toBe(",");
  });
});

test.describe("read-only explanations", () => {
  test("choosing the dimmed Edit Value item explains why in the read-only banner", async ({ page }) => {
    await boot(page, "id,name\n1,Alice\n", { defaultTableColumns: 2, editable: false, readOnlyReason: "encoding" });
    await cell(page, 0, 1).click({ button: "right" });
    // aria-disabled, which Playwright treats as not actionable, but a user can still choose it.
    await page.locator("#context-menu button", { hasText: "Edit Value" }).click({ force: true });
    await expect(page.locator("#readonly-banner")).toBeVisible();
    await expect(page.locator("#readonly-text")).toHaveText("This file isn't valid UTF-8, so Wide CSV opens it read-only. Use Open as Text to edit it.");
  });

  test("a restored edit that no longer matches is reported to the host without a banner of its own", async ({ page }) => {
    await boot(page, "id,name\n1,Alice\n2,Bob\n", {
      defaultTableColumns: 2,
      pendingEdits: [{ recordIndex: 2, originalFields: ["2", "NOT BOB"], fields: ["2", "Robert"] }],
    });
    await awaitPosted(page, "editsDropped");
    await expect(page.locator("#edit-error-banner")).toBeHidden();
  });
});
