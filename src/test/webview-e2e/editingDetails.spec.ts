import { expect, test, type Page } from "@playwright/test";
import { awaitPosted, bootAndLoad, clearPosted, defaultViewState, posted } from "./harness";

const FILE_KEY = "file:///details.csv";
const JSON_VALUE = '{"a":1,"b":[1,2]}';
const MD_VALUE = "# Title\n\n- one\n- two";

async function boot(page: Page, extra: { rows?: string[][]; visible?: Record<string, boolean> } = {}): Promise<void> {
  await bootAndLoad(page, {
    fileKey: FILE_KEY,
    headers: ["id", "name", "notes", "meta"],
    rows: extra.rows ?? [
      ["1", "Alice", MD_VALUE, JSON_VALUE],
      ["2", "Bob", "plain", ""],
    ],
    state: defaultViewState({ columnVisibility: extra.visible ?? { id: true, name: true, notes: false, meta: false } }),
    defaultTableColumns: 2,
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          (window as unknown as { __copied?: string }).__copied = text;
          return Promise.resolve();
        },
      },
      configurable: true,
    });
  });
}

const expand = (page: Page, rowId: number) => page.locator(`tr.data-row[data-row-id="${rowId}"] .twisty`).click();
const detail = (page: Page, rowId: number) => page.locator(`#detail-row-${rowId}`);
const editBtn = (page: Page, rowId: number, field: string) => detail(page, rowId).locator("dt", { hasText: new RegExp(`^${field}$`) }).locator(".field-edit-btn");
const editedMessages = async (page: Page) => (await posted(page)).filter((m) => m.type === "edit");

test("every field has an edit button after its copy button; a detail-only field opens a textarea with the raw value", async ({ page }) => {
  await boot(page);
  await expand(page, 0);
  const dt = detail(page, 0).locator("dt", { hasText: /^notes$/ });
  const buttons = await dt.locator("button").evaluateAll((els) => els.map((e) => e.className));
  expect(buttons[0]).toContain("field-copy-btn");
  expect(buttons[1]).toContain("field-edit-btn");
  await expect(editBtn(page, 0, "notes")).toHaveAttribute("aria-label", "Edit notes value");

  await editBtn(page, 0, "notes").click();
  const textarea = detail(page, 0).locator("textarea.field-editor");
  await expect(textarea).toHaveValue(MD_VALUE);
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveAttribute("aria-label", "Edit notes, row 1");
  await expect(detail(page, 0).locator("dd.editing")).toHaveCount(1);
  await expect(detail(page, 0).locator(".field-editor-hint")).toHaveText("Ctrl+Enter to apply · Esc to cancel");
  await expect(detail(page, 0).locator(".field-editor-actions .primary")).toHaveText("Apply");
});

test("a JSON field's textarea holds the raw text, not the formatted JSON", async ({ page }) => {
  await boot(page);
  await expand(page, 0);
  await editBtn(page, 0, "meta").click();
  await expect(detail(page, 0).locator("textarea.field-editor")).toHaveValue(JSON_VALUE);
});

test("an 'Also in table' field (clipped or multi-line table column) has an edit button too", async ({ page }) => {
  await boot(page, { visible: { id: true, name: true, notes: true, meta: false } });
  await expand(page, 0);
  await expect(detail(page, 0).locator(".detail-group-heading", { hasText: "Also in table" })).toBeVisible();
  await editBtn(page, 0, "notes").click();
  await expect(detail(page, 0).locator("textarea.field-editor")).toHaveValue(MD_VALUE);
});

test("Enter inserts a newline; Ctrl+Enter commits", async ({ page }) => {
  await boot(page);
  await expand(page, 1);
  await editBtn(page, 1, "notes").click();
  const textarea = detail(page, 1).locator("textarea.field-editor");
  await textarea.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect(textarea).toHaveValue("plain\nsecond");
  await clearPosted(page);
  await page.keyboard.press("Control+Enter");
  await expect(detail(page, 1).locator("textarea")).toHaveCount(0);
  const edit = await awaitPosted(page, "edit");
  expect((edit.change as Record<string, unknown>).newValue).toBe("plain\nsecond");
  expect((edit.change as Record<string, unknown>).oldValue).toBe("plain");
  await expect(detail(page, 1).locator("dd.edited-field")).toHaveCount(1);
});

test("Apply commits and Cancel discards", async ({ page }) => {
  await boot(page);
  await expand(page, 1);
  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill("applied");
  await detail(page, 1).locator(".field-editor-actions .primary").click();
  await expect(detail(page, 1).locator("dd", { hasText: "applied" })).toBeVisible();
  expect(await editedMessages(page)).toHaveLength(1);

  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill("discarded");
  await detail(page, 1).getByRole("button", { name: "Cancel" }).click();
  await expect(detail(page, 1).locator("dd", { hasText: "applied" })).toBeVisible();
  expect(await editedMessages(page)).toHaveLength(1);
});

test("Escape cancels", async ({ page }) => {
  await boot(page);
  await expand(page, 1);
  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill("nope");
  await page.keyboard.press("Escape");
  await expect(detail(page, 1).locator("textarea")).toHaveCount(0);
  await expect(detail(page, 1).locator("dd", { hasText: "plain" })).toBeVisible();
  expect(await editedMessages(page)).toHaveLength(0);
});

test("blur outside commits; clicking Apply does not commit twice", async ({ page }) => {
  await boot(page);
  await expand(page, 1);
  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill("blurred");
  await page.locator("#quick-search").click();
  await expect(detail(page, 1).locator("dd", { hasText: "blurred" })).toBeVisible();
  expect(await editedMessages(page)).toHaveLength(1);

  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill("via apply");
  await detail(page, 1).locator(".field-editor-actions .primary").click();
  await expect(detail(page, 1).locator("dd", { hasText: "via apply" })).toBeVisible();
  expect(await editedMessages(page)).toHaveLength(2);
});

test("after a commit the copy button copies the new value, JSON re-formats, Markdown re-renders, and focus lands on the edit button", async ({ page }) => {
  await boot(page);
  await expand(page, 0);
  await editBtn(page, 0, "meta").click();
  await detail(page, 0).locator("textarea").fill('{"z":true}');
  await page.keyboard.press("Control+Enter");
  await expect(detail(page, 0).locator(".detail-value-json")).toContainText('"z": true');
  await expect(editBtn(page, 0, "meta")).toBeFocused();
  await detail(page, 0).locator("dt", { hasText: /^meta$/ }).locator(".field-copy-btn").click();
  expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe('{"z":true}');

  await editBtn(page, 0, "notes").click();
  await detail(page, 0).locator("textarea").fill("## Heading\n\ntext");
  await page.keyboard.press("Control+Enter");
  await expect(detail(page, 0).locator(".detail-value-md h2")).toHaveText("Heading");
});

test("More/Less and Show all return clamped after committing a long value", async ({ page }) => {
  await boot(page);
  await expand(page, 1);
  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  await page.keyboard.press("Control+Enter");
  const dd = detail(page, 1).locator("dd").nth(0);
  await expect(dd.locator(".height-toggle-btn")).toHaveText("More");

  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill("w".repeat(12_000));
  await page.keyboard.press("Control+Enter");
  await expect(detail(page, 1).locator(".show-all-btn")).toContainText("Show all (12,000 characters)");
});

test("a value over 10,000 characters edits in full", async ({ page }) => {
  await boot(page, { rows: [["1", "Alice", "x".repeat(15_000), ""]] });
  await expand(page, 0);
  await editBtn(page, 0, "notes").click();
  await expect(detail(page, 0).locator("textarea")).toHaveValue("x".repeat(15_000));
});

test("a value over 1 MB has a disabled edit button with the explanatory title", async ({ page }) => {
  await boot(page, { rows: [["1", "Alice", "x".repeat(1024 * 1024 + 1), ""]] });
  await expand(page, 0);
  await expect(editBtn(page, 0, "notes")).toBeDisabled();
  await expect(editBtn(page, 0, "notes")).toHaveAttribute("title", "Too large to edit here (over 1 MB). Use Open as Text to change it.");
});

test("clicks inside the textarea never toggle the row; the native context menu is not intercepted", async ({ page }) => {
  await boot(page);
  await expand(page, 1);
  await editBtn(page, 1, "notes").click();
  const textarea = detail(page, 1).locator("textarea");
  await textarea.click();
  await textarea.dblclick();
  await expect(page.locator('tr.data-row[data-row-id="1"]')).toHaveAttribute("aria-expanded", "true");
  const prevented = await textarea.evaluate((el) => {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.locator("#context-menu")).toBeHidden();
});

test("the field context menu's Edit Value opens the details editor", async ({ page }) => {
  await boot(page);
  await expand(page, 1);
  await detail(page, 1).locator("dd").first().click({ button: "right" });
  await page.locator("#context-menu button", { hasText: "Edit Value" }).click();
  await expect(detail(page, 1).locator("textarea.field-editor")).toBeFocused();
});

test("a single-line table value can become multi-line and the 'Also in table' group follows the new value", async ({ page }) => {
  // Every column in the table and nothing clipped: the details fall back to listing every field.
  await boot(page, { visible: { id: true, name: true, notes: true, meta: true } });
  await expand(page, 1);
  await expect(detail(page, 1).locator(".detail-group-heading")).toHaveCount(0);
  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill("one\ntwo");
  await page.keyboard.press("Control+Enter");
  await expect(detail(page, 1).locator(".detail-group-heading")).toHaveText("Also in table");
  await expect(detail(page, 1).locator("dd.edited-field")).toHaveCount(1);
});

test("only one editor is open at a time: opening a second commits the first", async ({ page }) => {
  await boot(page);
  await expand(page, 1);
  await editBtn(page, 1, "notes").click();
  await detail(page, 1).locator("textarea").fill("first");
  await page.locator('tr.data-row[data-row-id="0"] td[data-column-index="1"]').dblclick();
  await expect(page.locator("textarea.field-editor")).toHaveCount(0);
  await expect(page.locator("input.cell-editor")).toHaveCount(1);
  expect(await editedMessages(page)).toHaveLength(1);
});
