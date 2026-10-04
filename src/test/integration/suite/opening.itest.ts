import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, waitForRender } from "../helpers";

const VIEW_TYPE = "csvViewer.table";

function fixture(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(WORKSPACE_ROOT, name));
}

suite("Opening", () => {
  suiteSetup(async () => {
    await getTestApi();
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("vscode.openWith opens a .csv into the table viewer without throwing", async () => {
    const uri = fixture("sample.csv");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const api = await getTestApi();
    const render = await waitForRender(api, fileKeyFor(uri));
    assert.deepStrictEqual(render.headers, ["id", "name", "note"]);
    assert.strictEqual(render.rowCount, 3);
  });

  test("csvViewer.open with an explicit uri opens the viewer", async () => {
    const uri = fixture("sample.csv");
    await openInViewer(uri);
    const api = await getTestApi();
    const render = await waitForRender(api, fileKeyFor(uri));
    assert.strictEqual(render.rowCount, 3);
  });

  test("csvViewer.open with no uri falls back to the active text editor", async () => {
    const uri = fixture("sample.csv");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("csvViewer.open");
    const api = await getTestApi();
    const render = await waitForRender(api, fileKeyFor(uri));
    assert.strictEqual(render.rowCount, 3);
  });

  test("csvViewer.open with no uri and no active editor shows an error, does not throw", async () => {
    await closeAllEditors();
    const api = await getTestApi();
    const before = api.getNotifications().length;
    await vscode.commands.executeCommand("csvViewer.open");
    const after = api.getNotifications();
    assert.ok(after.length > before, "expected a new notification to be recorded");
    const last = after[after.length - 1];
    assert.strictEqual(last.level, "error");
    assert.match(last.message, /no file to open/i);
  });

  test("opens a .tsv file, tab-delimited", async () => {
    const uri = fixture("sample.tsv");
    await openInViewer(uri);
    const api = await getTestApi();
    const render = await waitForRender(api, fileKeyFor(uri));
    assert.deepStrictEqual(render.headers, ["id", "name", "note"]);
    assert.strictEqual(render.rowCount, 2);
  });

  test("opens a .tab file, tab-delimited", async () => {
    const uri = fixture("sample.tab");
    await openInViewer(uri);
    const api = await getTestApi();
    const render = await waitForRender(api, fileKeyFor(uri));
    assert.deepStrictEqual(render.headers, ["id", "name", "note"]);
  });

  test("opens an uppercase .CSV file", async function () {
    const uri = fixture("UPPER.CSV");
    await openInViewer(uri);
    const api = await getTestApi();
    try {
      const render = await waitForRender(api, fileKeyFor(uri), 1, { timeoutMs: 3000 });
      assert.strictEqual(render.rowCount, 3);
    } catch (err) {
      throw new Error(`UPPER.CSV never rendered via the CSV viewer (see extension.ts/package.json case-sensitivity note): ${String(err)}`);
    }
  });

  test("path with spaces, unicode, '#', and '%' opens correctly", async () => {
    const uri = fixture("weird names/na me #1 100% ünïçode ✓.csv");
    await openInViewer(uri);
    const api = await getTestApi();
    const render = await waitForRender(api, fileKeyFor(uri));
    assert.strictEqual(render.rowCount, 3);
  });

  test("an empty file opens without throwing and shows zero rows", async () => {
    const uri = fixture("empty.csv");
    await openInViewer(uri);
    const api = await getTestApi();
    const render = await waitForRender(api, fileKeyFor(uri));
    assert.strictEqual(render.rowCount, 0);
  });

  test("a non-UTF8 (latin1) file opens without throwing", async () => {
    const uri = fixture("latin1.csv");
    await openInViewer(uri);
    const api = await getTestApi();
    const render = await waitForRender(api, fileKeyFor(uri));
    assert.strictEqual(render.rowCount, 2);
  });
});
