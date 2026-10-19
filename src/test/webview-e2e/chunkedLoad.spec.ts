import { expect, test, type Page } from "@playwright/test";
import { utf8Length } from "../../core/csvSerialize";
import { awaitPosted, bootShell, clearPosted, defaultViewState, postFromHost, postLoadChunk, postLoadHeader, posted, pushLoadChunked } from "./harness";

const FILE_KEY = "file:///chunked.csv";
// Multi-byte characters and a BOM, so chunk boundaries fall inside UTF-8 sequences.
const FILE = '﻿name,note\r\nÅsa,"naïve, café"\r\n日本,😀\r\nplain,x\r\n';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const load = { fileKey: FILE_KEY, state: defaultViewState(), defaultTableColumns: 4, testHooks: true };
const renderedRows = (page: Page): Promise<string[]> => page.locator("tr.data-row").evaluateAll((rows) => rows.map((r) => r.textContent ?? ""));

test.describe("a load whose bytes arrive in chunks", () => {
  for (const chunkBytes of [1, 3, 7, 1000]) {
    test(`renders the same table as a whole load, ${chunkBytes}-byte chunks`, async ({ page }) => {
      await bootShell(page);
      await pushLoadChunked(page, { ...load, bytes: encode(FILE) }, chunkBytes);
      await expect(page.locator("tr.data-row")).toHaveCount(3);
      const rows = (await renderedRows(page)).join("|");
      expect(rows).toContain("Åsa");
      expect(rows).toContain("naïve, café");
      expect(rows).toContain("日本");
      await expect(page.locator("#table-head th.sortable").first()).toHaveAttribute("data-column", "name");
    });
  }

  test("edits report exact byte offsets, before a save and after the text has been patched", async ({ page }) => {
    await bootShell(page);
    await pushLoadChunked(page, { ...load, bytes: encode(FILE) }, 5);
    await expect(page.locator("tr.data-row")).toHaveCount(3);
    const cell = (row: number, column: number) => page.locator(`tr.data-row[data-row-id="${row}"] td[data-column-index="${column}"]`);

    await cell(1, 0).dblclick();
    await page.locator("input.cell-editor").fill("日本語");
    await clearPosted(page);
    await page.keyboard.press("Enter");
    const first = (await awaitPosted(page, "edit")).change as Record<string, any>;
    expect(first.record.byteStart).toBe(utf8Length(FILE, 0, first.record.charStart));
    expect(first.record.byteEnd).toBe(utf8Length(FILE, 0, first.record.charEnd));

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

  test("what the host sends after the header waits for the whole load", async ({ page }) => {
    await bootShell(page);
    const bytes = encode(FILE);
    await postLoadHeader(page, load, 1, bytes.length);
    await postFromHost(page, { type: "fileDeleted", name: "chunked.csv" });
    await postLoadChunk(page, 1, 0, bytes.subarray(0, 10));
    await expect(page.locator("#file-deleted-banner")).toBeHidden();
    await postLoadChunk(page, 1, 10, bytes.subarray(10));
    await expect(page.locator("tr.data-row")).toHaveCount(3);
    await expect(page.locator("#file-deleted-banner")).toBeVisible();
  });

  test("chunks of a load that a newer one replaced are ignored", async ({ page }) => {
    await bootShell(page);
    const stale = encode("old\r\nstale\r\n");
    await postLoadHeader(page, load, 1, stale.length);
    await postLoadChunk(page, 1, 0, stale.subarray(0, 4));
    await pushLoadChunked(page, { ...load, bytes: encode(FILE) }, 9, 2);
    await postLoadChunk(page, 1, 4, stale.subarray(4));
    await expect(page.locator("tr.data-row")).toHaveCount(3);
    expect((await renderedRows(page)).join("|")).not.toContain("stale");
    expect((await posted(page)).filter((m) => m.type === "resync")).toHaveLength(0);
  });

  test("a chunk out of order asks the host for a full load instead of assembling a wrong file", async ({ page }) => {
    await bootShell(page);
    const bytes = encode(FILE);
    await postLoadHeader(page, load, 1, bytes.length);
    await postLoadChunk(page, 1, 0, bytes.subarray(0, 10));
    await postLoadChunk(page, 1, 20, bytes.subarray(20, 30));
    await awaitPosted(page, "resync");
    await expect(page.locator("tr.data-row")).toHaveCount(0);
    // The full load the host answers with is taken as usual.
    await pushLoadChunked(page, { ...load, bytes }, 16, 2);
    await expect(page.locator("tr.data-row")).toHaveCount(3);
  });
});
