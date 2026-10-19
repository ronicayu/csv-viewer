import { expect, test, type Page } from "@playwright/test";
import { utf8Length } from "../../core/csvSerialize";
import { awaitPosted, bootShell, clearPosted, defaultViewState, postFromHost, pushLoadBytes, pushLoadText } from "./harness";

const FILE_KEY = "file:///bytes.csv";
const FILE = '﻿name,note\r\nÅsa,"naïve, café"\r\n日本,😀\r\nplain,x\r\n';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const load = { fileKey: FILE_KEY, state: defaultViewState(), defaultTableColumns: 4, testHooks: true };

const renderedRows = (page: Page): Promise<string[]> => page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.textContent ?? ""));

test.describe("a load that carries bytes", () => {
  test("renders the same table as a load that carries the text", async ({ page }) => {
    await bootShell(page);
    await pushLoadText(page, { ...load, text: FILE });
    await expect(page.locator("tr.data-row")).toHaveCount(3);
    const fromText = await renderedRows(page);

    await bootShell(page);
    await pushLoadBytes(page, { ...load, bytes: encode(FILE) });
    await expect(page.locator("tr.data-row")).toHaveCount(3);
    expect(await renderedRows(page)).toEqual(fromText);
    expect(fromText.join("|")).toContain("Åsa");
    expect(fromText.join("|")).toContain("naïve, café");
    await expect(page.locator("#table-head th.sortable").first()).toHaveAttribute("data-column", "name");
  });

  test("decodes invalid UTF-8 with replacement characters, as the host's lossy decode did", async ({ page }) => {
    await bootShell(page);
    await pushLoadBytes(page, { ...load, editable: false, readOnlyReason: "encoding", bytes: Uint8Array.from([...encode("name,note\n"), 0x63, 0x61, 0x66, 0xe9, 0x2c, 0x6f, 0x6b, 0x0a]) });
    await expect(page.locator("tr.data-row")).toHaveCount(1);
    await expect(page.locator('tr.data-row td[data-column-index="0"]')).toHaveText("caf�");
  });

  test("edits report exact byte offsets, before a save and after the text has been patched", async ({ page }) => {
    await bootShell(page);
    await pushLoadBytes(page, { ...load, bytes: encode(FILE) });
    await expect(page.locator("tr.data-row")).toHaveCount(3);
    const cell = (row: number, column: number) => page.locator(`tr.data-row[data-row-id="${row}"] td[data-column-index="${column}"]`);

    await cell(1, 0).dblclick();
    await page.locator("input.cell-editor").fill("日本語");
    await clearPosted(page);
    await page.keyboard.press("Enter");
    const first = (await awaitPosted(page, "edit")).change as Record<string, any>;
    expect(first.record.byteStart).toBe(utf8Length(FILE, 0, first.record.charStart));
    expect(first.record.byteEnd).toBe(utf8Length(FILE, 0, first.record.charEnd));
    expect(first.record.byteEnd - first.record.charEnd).toBeGreaterThan(0);

    await postFromHost(page, { type: "saved", baseVersion: 2, written: [{ recordIndex: 2, fields: ["日本語", "😀"] }] });
    const patched = FILE.replace("日本,😀", "日本語,😀");
    await cell(2, 0).dblclick();
    await page.locator("input.cell-editor").fill("p");
    await clearPosted(page);
    await page.keyboard.press("Enter");
    const second = (await awaitPosted(page, "edit")).change as Record<string, any>;
    expect(second.record.byteStart).toBe(utf8Length(patched, 0, second.record.charStart));
    expect(second.record.byteEnd).toBe(utf8Length(patched, 0, second.record.charEnd));
  });

  test("an ASCII file's byte offsets are its character offsets", async ({ page }) => {
    const ascii = "a,b\r\n1,2\r\n3,4\r\n";
    await bootShell(page);
    await pushLoadBytes(page, { ...load, bytes: encode(ascii) });
    await expect(page.locator("tr.data-row")).toHaveCount(2);
    await page.locator('tr.data-row[data-row-id="1"] td[data-column-index="1"]').dblclick();
    await page.locator("input.cell-editor").fill("x");
    await clearPosted(page);
    await page.keyboard.press("Enter");
    const change = (await awaitPosted(page, "edit")).change as Record<string, any>;
    expect(change.record).toMatchObject({ charStart: 10, charEnd: 13, byteStart: 10, byteEnd: 13 });
  });
});
