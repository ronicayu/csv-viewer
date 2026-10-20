import { expect, test, type Page } from "@playwright/test";
import Papa from "papaparse";
import { splitRecords } from "../../core/recordSpans";
import { utf8Length } from "../../core/csvSerialize";
import { awaitPosted, bootAndLoad, bootAndLoadText, clearPosted, defaultViewState, posted, postFromHost } from "./harness";
import { smallFixture } from "./fixtures";

const FILE_KEY = "file:///people.csv";

async function boot(page: Page, overrides: Partial<Parameters<typeof bootAndLoad>[1]> = {}): Promise<void> {
  await bootAndLoad(page, {
    fileKey: FILE_KEY,
    headers: smallFixture.headers,
    rows: smallFixture.rows,
    state: defaultViewState(),
    defaultTableColumns: 4,
    ...overrides,
  });
}

const cell = (page: Page, rowId: number, columnIndex: number) =>
  page.locator(`tr.data-row[data-row-id="${rowId}"] td[data-column-index="${columnIndex}"]`);

async function editMessages(page: Page): Promise<Array<Record<string, any>>> {
  return (await posted(page)).filter((m) => m.type === "edit");
}

test.describe("inline editing", () => {
  test("double-click opens an input holding the full value, selected, labelled with column and row", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).dblclick();
    const input = page.locator("input.cell-editor");
    await expect(input).toHaveCount(1);
    await expect(input).toHaveValue("Alice");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-label", "Edit name, row 1");
    const selection = await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
    expect(selection).toEqual([0, 5]);
    await expect(cell(page, 0, 1)).toHaveClass(/editing/);
  });

  test("Enter commits: the cell shows the new text, is marked, and exactly one edit message carries the record's spans", async ({ page }) => {
    await boot(page);
    const text = Papa.unparse({ fields: smallFixture.headers, data: smallFixture.rows });
    await cell(page, 1, 1).dblclick();
    await page.locator("input.cell-editor").fill("Robert");
    await clearPosted(page);
    await page.keyboard.press("Enter");

    const td = cell(page, 1, 1);
    await expect(td).toHaveText("Robert");
    await expect(td).toHaveClass(/edited-cell/);
    await expect(td).toHaveAttribute("aria-description", "Edited, not saved");
    await expect(td).toHaveAttribute("title", "Edited (not saved). Original: Bob");

    const edit = await awaitPosted(page, "edit");
    expect(await editMessages(page)).toHaveLength(1);
    const change = edit.change as Record<string, any>;
    expect(edit.baseVersion).toBe(1);
    expect(change).toMatchObject({ rowId: 1, recordIndex: 2, columnIndex: 1, oldValue: "Bob", newValue: "Robert" });

    const span = splitRecords(text, { delimiter: ",", quotes: true })[2];
    expect(change.record.charStart).toBe(span.start);
    expect(change.record.charEnd).toBe(span.end);
    expect(change.record.byteStart).toBe(utf8Length(text, 0, span.start));
    expect(change.record.byteEnd).toBe(utf8Length(text, 0, span.end));
    expect(change.record.originalText).toBe("2,Bob,25,LA");
    expect(change.record.originalFields).toEqual(["2", "Bob", "25", "LA"]);
    expect(change.record.eol).toBe("\r\n");
    expect(change.format).toEqual({ delimiter: ",", quoting: true });
  });

  test("Escape cancels and posts nothing", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).dblclick();
    await page.locator("input.cell-editor").fill("Changed");
    await clearPosted(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("input.cell-editor")).toHaveCount(0);
    await expect(cell(page, 0, 1)).toHaveText("Alice");
    await expect(cell(page, 0, 1)).not.toHaveClass(/edited-cell/);
    expect(await editMessages(page)).toHaveLength(0);
  });

  test("blur commits", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 3).dblclick();
    await page.locator("input.cell-editor").fill("Boston");
    await page.locator("#quick-search").click();
    await expect(cell(page, 0, 3)).toHaveText("Boston");
    await awaitPosted(page, "edit");
  });

  test("committing the unchanged value posts nothing and marks nothing", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).dblclick();
    await clearPosted(page);
    await page.keyboard.press("Enter");
    await expect(page.locator("input.cell-editor")).toHaveCount(0);
    await expect(cell(page, 0, 1)).not.toHaveClass(/edited-cell/);
    expect(await editMessages(page)).toHaveLength(0);
  });

  test("F2 on the focused row edits its first cell; Tab and Shift+Tab move across the row; Tab off the last cell returns to the row", async ({ page }) => {
    await boot(page);
    await page.locator("tr.data-row").first().focus();
    await page.keyboard.press("F2");
    await expect(cell(page, 0, 0).locator("input.cell-editor")).toBeFocused();

    await page.keyboard.type("10");
    await page.keyboard.press("Tab");
    await expect(cell(page, 0, 0)).toHaveText("10");
    await expect(cell(page, 0, 1).locator("input.cell-editor")).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    await expect(cell(page, 0, 0).locator("input.cell-editor")).toBeFocused();

    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(cell(page, 0, 3).locator("input.cell-editor")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("input.cell-editor")).toHaveCount(0);
    await expect(page.locator('tr.data-row[data-row-id="0"]')).toBeFocused();
  });

  test("focus returns to the row after Enter and after Escape", async ({ page }) => {
    await boot(page);
    await cell(page, 2, 1).dblclick();
    await page.keyboard.press("Enter");
    await expect(page.locator('tr.data-row[data-row-id="2"]')).toBeFocused();
    await cell(page, 2, 1).dblclick();
    await page.keyboard.press("Escape");
    await expect(page.locator('tr.data-row[data-row-id="2"]')).toBeFocused();
  });

  test("a double-click leaves the row's expansion as it was", async ({ page }) => {
    await boot(page);
    const row = page.locator('tr.data-row[data-row-id="0"]');
    await cell(page, 0, 1).dblclick();
    await expect(page.locator("input.cell-editor")).toHaveCount(1);
    await expect(row).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Escape");
    await row.locator(".twisty").click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await cell(page, 0, 1).dblclick();
    await expect(page.locator("input.cell-editor")).toHaveCount(1);
    await expect(row).toHaveAttribute("aria-expanded", "true");
  });

  test("clicks and selections inside the input never toggle the row", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).dblclick();
    await page.locator("input.cell-editor").dblclick();
    await page.locator("input.cell-editor").click();
    await expect(page.locator('tr.data-row[data-row-id="0"]')).toHaveAttribute("aria-expanded", "false");
  });

  test("header cells and the chevron cell never open an editor", async ({ page }) => {
    await boot(page);
    await page.locator("th", { hasText: "name" }).dblclick();
    await page.locator('tr.data-row[data-row-id="0"] td.chevron-col').dblclick();
    await expect(page.locator("input.cell-editor, textarea.field-editor")).toHaveCount(0);
  });

  test("a multi-line value redirects to the details editor: the row expands and the field's textarea opens", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: FILE_KEY,
      headers: ["id", "note"],
      rows: [["1", "line one\nline two"]],
      state: defaultViewState({ columnVisibility: { id: true, note: true } }),
      defaultTableColumns: 2,
    });
    await cell(page, 0, 1).dblclick();
    await expect(page.locator("input.cell-editor")).toHaveCount(0);
    await expect(page.locator("tr.detail-row")).toBeVisible();
    const textarea = page.locator("textarea.field-editor");
    await expect(textarea).toHaveCount(1);
    await expect(textarea).toHaveValue("line one\nline two");
    await expect(page.locator(".detail-group-heading", { hasText: "Also in table" })).toBeVisible();
  });

  test("500 characters edit inline; 501 redirect to the details", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: FILE_KEY,
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
    await expect(page.locator("input.cell-editor")).toHaveValue("x".repeat(500));
    await page.keyboard.press("Escape");

    await cell(page, 1, 1).dblclick();
    await expect(page.locator("input.cell-editor")).toHaveCount(0);
    await expect(page.locator("textarea.field-editor")).toHaveValue("y".repeat(501));
  });

  test("a value over 1 MB is refused with the banner sentence", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: FILE_KEY,
      headers: ["id", "note"],
      rows: [["1", "z".repeat(1024 * 1024 + 1)]],
      state: defaultViewState({ columnVisibility: { id: true, note: true } }),
      defaultTableColumns: 2,
    });
    await cell(page, 0, 1).dblclick();
    await expect(page.locator("input.cell-editor, textarea.field-editor")).toHaveCount(0);
    await expect(page.locator("#edit-error-banner")).toBeVisible();
    await expect(page.locator("#edit-error-text")).toHaveText("Too large to edit here (over 1 MB). Use Open as Text to change it.");
  });

  test("the cell context menu leads with Edit Value; Revert Cell appears only for an edited cell and posts an edit back to the original", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).click({ button: "right" });
    const items = page.locator("#context-menu button");
    await expect(items.first()).toHaveText("Edit Value");
    await expect(page.locator("#context-menu button", { hasText: "Revert Cell" })).toHaveCount(0);
    await items.first().click();
    await expect(page.locator("input.cell-editor")).toBeFocused();
    await page.keyboard.type("Zed");
    await page.keyboard.press("Enter");
    await expect(cell(page, 0, 1)).toHaveText("Zed");

    await cell(page, 0, 1).click({ button: "right" });
    const revert = page.locator("#context-menu button", { hasText: "Revert Cell" });
    await expect(revert).toHaveText('Revert Cell to "Alice"');
    await clearPosted(page);
    await revert.click();
    await expect(cell(page, 0, 1)).toHaveText("Alice");
    await expect(cell(page, 0, 1)).not.toHaveClass(/edited-cell/);
    const edit = await awaitPosted(page, "edit");
    expect((edit.change as Record<string, unknown>).newValue).toBe("Alice");
    expect((edit.change as Record<string, unknown>).oldValue).toBe("Zed");
  });

  test("retyping the original value clears the mark", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).dblclick();
    await page.keyboard.type("Other");
    await page.keyboard.press("Enter");
    await expect(cell(page, 0, 1)).toHaveClass(/edited-cell/);
    await cell(page, 0, 1).dblclick();
    await page.keyboard.type("Alice");
    await page.keyboard.press("Enter");
    await expect(cell(page, 0, 1)).not.toHaveClass(/edited-cell/);
  });

  test("a commit is announced in #edit-status", async ({ page }) => {
    await boot(page);
    await cell(page, 0, 1).dblclick();
    await page.keyboard.type("Alicia");
    await page.keyboard.press("Enter");
    await expect(page.locator("#edit-status")).toHaveText('name, row 1: changed to "Alicia"');
    await expect(page.locator("#edit-status")).toHaveAttribute("role", "status");
  });

  test("the cell title is recomputed on hover, prefixed by the edit note when the cell is also clipped", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: FILE_KEY,
      headers: ["id", "note"],
      rows: [["1", "short"]],
      state: defaultViewState({ columnVisibility: { id: true, note: true } }),
      defaultTableColumns: 2,
    });
    await cell(page, 0, 1).dblclick();
    await page.keyboard.type("w".repeat(200));
    await page.keyboard.press("Enter");
    await cell(page, 0, 1).hover();
    const title = await cell(page, 0, 1).getAttribute("title");
    expect(title).toBe(`Edited (not saved). Original: short\n${"w".repeat(200)}`);
  });

  test("a quotes-off parse rejects a value containing the separator and keeps the editor open", async ({ page }) => {
    await bootAndLoad(page, {
      fileKey: FILE_KEY,
      headers: smallFixture.headers,
      rows: smallFixture.rows,
      state: defaultViewState({ quotes: false }),
      defaultTableColumns: 4,
    });
    await cell(page, 0, 1).dblclick();
    await page.keyboard.type("a,b");
    await clearPosted(page);
    await page.keyboard.press("Enter");
    await expect(page.locator("#edit-error-banner")).toBeVisible();
    await expect(page.locator("#edit-error-text")).toHaveText("With Quoted fields off, a value can't contain the separator or a line break.");
    await expect(page.locator("input.cell-editor")).toHaveValue("a,b");
    expect(await editMessages(page)).toHaveLength(0);
  });

  test("an edit the worker rejects restores the cell and shows the reason in the banner", async ({ page }) => {
    await bootAndLoadText(page, {
      fileKey: FILE_KEY,
      text: "name\nalpha\nbeta\n",
      state: defaultViewState(),
      defaultTableColumns: 4,
    });
    await cell(page, 0, 0).dblclick();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Enter");
    await expect(page.locator("#edit-error-text")).toHaveText("Couldn't edit row 1: an empty value would leave this row empty, which removes it from the file.");
    await expect(cell(page, 0, 0)).toHaveText("alpha");
    await expect(cell(page, 0, 0)).not.toHaveClass(/edited-cell/);
  });

  test("Ctrl+Z from an open editor does not reach window listeners; with no editor it does", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      (window as unknown as { __undoKeys: string[] }).__undoKeys = [];
      window.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") (window as unknown as { __undoKeys: string[] }).__undoKeys.push(ev.key);
      });
    });
    await cell(page, 0, 1).dblclick();
    await page.keyboard.press("Control+z");
    expect(await page.evaluate(() => (window as unknown as { __undoKeys: string[] }).__undoKeys.length)).toBe(0);
    await page.keyboard.press("Escape");
    await page.locator("#quick-search").focus();
    await page.keyboard.press("Control+z");
    expect(await page.evaluate(() => (window as unknown as { __undoKeys: string[] }).__undoKeys.length)).toBe(1);
  });
});

test.describe("when editing is unavailable", () => {
  test('"setting" draws no affordances: no field edit buttons, no Edit Value, F2 and double-click do nothing', async ({ page }) => {
    await boot(page, { editable: false, readOnlyReason: "setting" });
    await page.locator('tr.data-row[data-row-id="0"] .twisty').click();
    await expect(page.locator(".field-edit-btn")).toHaveCount(0);
    await cell(page, 0, 1).click({ button: "right" });
    await expect(page.locator("#context-menu button", { hasText: "Edit Value" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.locator('tr.data-row[data-row-id="1"]').focus();
    await page.keyboard.press("F2");
    await cell(page, 1, 1).dblclick();
    await expect(page.locator("input.cell-editor, textarea.field-editor")).toHaveCount(0);
    await expect(page.locator("#readonly-banner")).toBeHidden();
  });

  for (const [reason, sentence] of [
    ["encoding", "This file isn't valid UTF-8, so Wide CSV opens it read-only. Use Open as Text to edit it."],
    ["filesystem", "This file system is read-only."],
  ] as const) {
    test(`"${reason}" shows disabled controls and the read-only banner on the first attempt`, async ({ page }) => {
      await boot(page, { editable: false, readOnlyReason: reason });
      await expect(page.locator("#readonly-banner")).toBeHidden();
      await page.locator('tr.data-row[data-row-id="0"] .twisty').click();
      await expect(page.locator(".field-edit-btn").first()).toBeDisabled();
      await cell(page, 0, 1).click({ button: "right" });
      const edit = page.locator("#context-menu button", { hasText: "Edit Value" });
      await expect(edit).toBeDisabled();
      await expect(edit).toHaveAttribute("title", sentence);
      await page.keyboard.press("Escape");

      await cell(page, 1, 1).dblclick();
      await expect(page.locator("input.cell-editor")).toHaveCount(0);
      await expect(page.locator("#readonly-banner")).toBeVisible();
      await expect(page.locator("#readonly-text")).toHaveText(sentence);
      await expect(page.locator("#readonly-open-as-text-btn")).toBeVisible();

      await page.locator("#readonly-dismiss-btn").click();
      await expect(page.locator("#readonly-banner")).toBeHidden();
      await cell(page, 1, 1).dblclick();
      await expect(page.locator("#readonly-banner")).toBeHidden();
    });
  }

  test("the read-only banner's Open as Text button posts openAsText", async ({ page }) => {
    await boot(page, { editable: false, readOnlyReason: "encoding" });
    await page.locator('tr.data-row[data-row-id="0"]').focus();
    await page.keyboard.press("F2");
    await clearPosted(page);
    await page.locator("#readonly-open-as-text-btn").click();
    await awaitPosted(page, "openAsText");
  });

  test("setEditable flips affordances at runtime", async ({ page }) => {
    await boot(page);
    await page.locator('tr.data-row[data-row-id="0"] .twisty').click();
    await expect(page.locator(".field-edit-btn").first()).toBeVisible();

    await postFromHost(page, { type: "setEditable", editable: false, readOnlyReason: "setting" });
    await expect(page.locator(".field-edit-btn")).toHaveCount(0);

    await postFromHost(page, { type: "setEditable", editable: true });
    await page.locator('tr.data-row[data-row-id="0"] .twisty').click();
    await page.locator('tr.data-row[data-row-id="0"] .twisty').click();
    await expect(page.locator(".field-edit-btn").first()).toBeVisible();
    await cell(page, 0, 1).dblclick();
    await expect(page.locator("input.cell-editor")).toHaveCount(1);
  });
});
