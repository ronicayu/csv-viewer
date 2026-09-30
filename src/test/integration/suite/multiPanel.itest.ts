// Covers: same file open in a text editor and the viewer side by side;
// two different files open in two viewers at once (no state leakage);
// close/reopen persistence; renaming the open file; csvViewer.openAsText.

import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, renderCount, sleep, waitFor, waitForRender, waitForSaveState } from "../helpers";

const VIEW_TYPE = "csvViewer.table";

function fixture(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(WORKSPACE_ROOT, name));
}

suite("Side-by-side, multiple viewers, and openAsText", () => {
  suiteSetup(async () => {
    await getTestApi(); // ensures the extension is activated before any test in this file
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("same file open in a text editor and the viewer side by side: an unsaved edit in the text editor does NOT reload the viewer, but saving it does", async () => {
    // FIXED behavior (see docs/spec.md's "Unsaved edits" note): the viewer
    // is a CustomReadonlyEditorProvider now, so it never gets a synced
    // TextDocument from the side-by-side text editor — it only reloads
    // from what's actually on disk, via its FileSystemWatcher. An edit
    // that hasn't been saved yet has no effect on disk, so it's
    // deliberately not reflected until the user saves.
    const uri = fixture("sidebyside.csv");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, vscode.ViewColumn.Two);

    const api = await getTestApi();
    const key = fileKeyFor(uri);
    const initial = await waitForRender(api, key);
    assert.strictEqual(initial.rowCount, 2);
    const countAfterOpen = renderCount(api, key);

    const edit = new vscode.WorkspaceEdit();
    const endPos = doc.lineAt(doc.lineCount - 1).range.end;
    edit.insert(uri, endPos, "\n3,c");
    await vscode.workspace.applyEdit(edit);

    await sleep(1000); // give the (deliberately absent) reload a chance to fire if it were going to
    assert.strictEqual(renderCount(api, key), countAfterOpen, "an unsaved edit must not reload the side-by-side viewer");

    await doc.save();

    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[];
        const last = renders[renders.length - 1];
        return last !== undefined && last.rowCount === 3;
      },
      { timeoutMs: 6000, message: "saving the text editor never reloaded the side-by-side viewer" },
    );
  });

  test("two different files open in two viewers at once render independently, with no cross-talk", async () => {
    const uriA = fixture("fileA.csv");
    const uriB = fixture("fileB.csv");
    await openInViewer(uriA);
    await openInViewer(uriB);

    const api = await getTestApi();
    const keyA = fileKeyFor(uriA);
    const keyB = fileKeyFor(uriB);
    const renderA = await waitForRender(api, keyA);
    const renderB = await waitForRender(api, keyB);

    assert.deepStrictEqual(renderA.headers, ["id", "name"]);
    assert.deepStrictEqual(renderB.headers, ["sku", "qty"]);
    assert.ok(api.panelCount() >= 2, `expected at least 2 live panels, got ${api.panelCount()}`);

    // Cross-talk check: every "rendered" message recorded under A's key
    // reports A's headers, never B's, and vice versa.
    const allA = api.getMessages(keyA).filter((m) => m.type === "rendered") as { headers: string[] }[];
    const allB = api.getMessages(keyB).filter((m) => m.type === "rendered") as { headers: string[] }[];
    assert.ok(allA.every((r) => JSON.stringify(r.headers) === JSON.stringify(["id", "name"])));
    assert.ok(allB.every((r) => JSON.stringify(r.headers) === JSON.stringify(["sku", "qty"])));
  });

  test("delimiter state is keyed per file, not shared, verified through the real webview via a synthetic load", async () => {
    const uriA = fixture("fileA.csv");
    const uriB = fixture("fileB.csv");
    await openInViewer(uriA);
    await openInViewer(uriB);
    const api = await getTestApi();
    const keyA = fileKeyFor(uriA);
    const keyB = fileKeyFor(uriB);
    await waitForRender(api, keyA);
    await waitForRender(api, keyB);

    const textA = await fsp.readFile(path.join(WORKSPACE_ROOT, "fileA.csv"), "utf8");
    // TESTING NOTE (not a product bug): `webview.postMessage()` to a
    // *background* webview went silently undelivered in this harness even
    // with `retainContextWhenHidden: true` set on webviewPanel.options —
    // no "rendered" (or anything else) ever arrived for fileA while fileB's
    // panel was the foreground tab. Bringing fileA back to the foreground
    // first (reopening an already-open customEditor document just reveals
    // the existing panel, since supportsMultipleEditorsPerDocument is
    // false) fixed it. Real users driving the UI wouldn't hit this since
    // messages always originate from the panel that's currently being
    // interacted with; it only bit this test hook's postToWebview, which
    // can target any panel regardless of focus.
    await openInViewer(uriA);
    await sleep(500); // let any focus-triggered activity from reopening settle first
    const before = renderCount(api, keyA);

    // Simulate "a previously-saved per-file state had delimiter: ';'"
    // (fileA.csv has no semicolons, so this collapses every row to one
    // column) by posting a synthetic `load` straight into fileA's live
    // webview — this runs the real onLoad()/parseCsv() code, not a mock.
    const posted = api.postToWebview(keyA, {
      type: "load",
      fileKey: keyA,
      text: textA,
      state: { columnVisibility: {}, filterRules: [], quickSearch: "", sortKeys: [], firstRowIsHeader: true, pageSize: 100, delimiter: ";" },
      defaultTableColumns: 8,
      defaultDelimiter: "",
      testHooks: true,
    });
    assert.ok(posted, "postToWebview found no live panel for fileA");

    await waitFor(() => renderCount(api, keyA) > before, { message: "synthetic load for fileA never rendered" });
    const rendersA = api.getMessages(keyA).filter((m) => m.type === "rendered") as { headers: string[] }[];
    assert.strictEqual(rendersA[rendersA.length - 1].headers.length, 1, "forcing delimiter=';' on text with no semicolons should collapse to a single column");

    // fileB must be totally unaffected.
    const rendersB = api.getMessages(keyB).filter((m) => m.type === "rendered") as { headers: string[] }[];
    assert.deepStrictEqual(rendersB[rendersB.length - 1].headers, ["sku", "qty"]);
    // NOTE ON COVERAGE: column-visibility isolation is not directly
    // observable this way — RenderedMessage only carries the full header
    // list and filtered row count, neither of which reflects
    // table-vs-detail visibility. That dimension is covered by the
    // Playwright webview-e2e suite (columns.spec.ts) instead; what this
    // test proves at the *host* level is that two panels never cross-wire
    // their live webview instances or their parsed data.
  });

  test("opening a fresh file triggers an automatic saveState (first-open visibility reconciliation writes to workspaceState)", async () => {
    const uri = fixture("fileA.csv");
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);
    await waitFor(() => api.getMessages(key).some((m) => m.type === "saveState"), {
      message: "expected an automatic saveState after first-open visibility reconciliation",
    });
  });

  test("closing and reopening the same file does not re-fire saveState (visibility state was actually persisted per file)", async () => {
    const uri = fixture("fileB.csv");
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);
    await waitFor(() => api.getMessages(key).some((m) => m.type === "saveState"));
    const countAfterFirstOpen = api.getMessages(key).length;

    await closeAllEditors();
    await sleep(300);
    await openInViewer(uri);
    await waitFor(() => api.getMessages(key).length > countAfterFirstOpen, { message: "expected a new ready/rendered cycle on reopen" });
    await sleep(1000); // give any (unwanted) reconciliation-driven saveState time to arrive if it were going to

    const newMessages = api.getMessages(key).slice(countAfterFirstOpen);
    const newSaveStates = newMessages.filter((m) => m.type === "saveState");
    assert.strictEqual(
      newSaveStates.length,
      0,
      `reopening an already-settled file should not re-trigger a visibility write; got ${JSON.stringify(newSaveStates)}`,
    );
  });

  test("FIXED: renaming a file with saved per-file state migrates that state to the new uri's key, deleting the old one", async () => {
    const oldPath = path.join(WORKSPACE_ROOT, "renameme.csv");
    const newPath = path.join(WORKSPACE_ROOT, "renamed-target.csv");
    const oldUri = vscode.Uri.file(oldPath);
    await openInViewer(oldUri);
    const api = await getTestApi();
    const oldKey = fileKeyFor(oldUri);
    await waitForRender(api, oldKey);
    await waitForSaveState(api, oldKey); // persisted under oldKey by first-open reconciliation

    const oldStateKey = "csvViewer.state:" + oldKey;
    assert.ok(api.getWorkspaceStateKeys().includes(oldStateKey), "expected persisted state under the old uri's key before renaming");

    await closeAllEditors();
    const newUri = vscode.Uri.file(newPath);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(oldUri, newUri);
    await vscode.workspace.applyEdit(edit);

    const newKey = fileKeyFor(newUri);
    const newStateKey = "csvViewer.state:" + newKey;
    await waitFor(() => api.getWorkspaceStateKeys().includes(newStateKey), {
      message: "expected the renamed file's state to appear under the new uri's key",
    });
    assert.ok(!api.getWorkspaceStateKeys().includes(oldStateKey), "expected the old uri's key to be gone after migration");

    // Decided behavior (see docs/spec.md): opening the renamed file re-uses
    // the migrated state, so first-open reconciliation is a no-op (headers
    // are unchanged) and does NOT fire a fresh saveState — unlike a
    // genuinely new file (see the "closing and reopening" test above).
    await openInViewer(newUri);
    await waitForRender(api, newKey);
    await sleep(1000);
    const saveStatesForNewKey = api.getMessages(newKey).filter((m) => m.type === "saveState");
    assert.strictEqual(
      saveStatesForNewKey.length,
      0,
      `expected no fresh saveState after opening the renamed file (state was migrated, not orphaned); got ${JSON.stringify(saveStatesForNewKey)}`,
    );
  });

  test("FIXED: renaming a folder migrates every nested file's saved state to the new folder prefix", async () => {
    const folderName = `rename-folder-${Date.now()}`;
    const newFolderName = `${folderName}-renamed`;
    const oldFolderUri = vscode.Uri.file(path.join(WORKSPACE_ROOT, folderName));
    const nestedPath = path.join(WORKSPACE_ROOT, folderName, "nested.csv");
    await fsp.mkdir(path.dirname(nestedPath), { recursive: true });
    await fsp.writeFile(nestedPath, "a,b\n1,2\n");
    const nestedUri = vscode.Uri.file(nestedPath);

    await openInViewer(nestedUri);
    const api = await getTestApi();
    const nestedKey = fileKeyFor(nestedUri);
    await waitForRender(api, nestedKey);
    await waitForSaveState(api, nestedKey);
    const oldNestedStateKey = "csvViewer.state:" + nestedKey;
    assert.ok(api.getWorkspaceStateKeys().includes(oldNestedStateKey));

    await closeAllEditors();
    const newFolderUri = vscode.Uri.file(path.join(WORKSPACE_ROOT, newFolderName));
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(oldFolderUri, newFolderUri);
    await vscode.workspace.applyEdit(edit);

    const newNestedUri = vscode.Uri.file(path.join(WORKSPACE_ROOT, newFolderName, "nested.csv"));
    const newNestedStateKey = "csvViewer.state:" + fileKeyFor(newNestedUri);
    await waitFor(() => api.getWorkspaceStateKeys().includes(newNestedStateKey), {
      message: "expected the nested file's state to migrate under the renamed folder's new prefix",
    });
    assert.ok(!api.getWorkspaceStateKeys().includes(oldNestedStateKey), "expected the old nested key to be gone after the folder rename");
  });

  test("csvViewer.openAsText from the viewer switches the active editor to the default text editor", async () => {
    const uri = fixture("fileA.csv");
    await openInViewer(uri);
    const api = await getTestApi();
    await waitForRender(api, fileKeyFor(uri));

    await vscode.commands.executeCommand("csvViewer.openAsText");
    await sleep(500);

    const active = vscode.window.activeTextEditor;
    assert.ok(active, "expected a text editor to be active after openAsText");
    assert.strictEqual(active!.document.uri.toString(), fileKeyFor(uri));
  });

  test("csvViewer.openAsText with no viewer currently active does not throw", async () => {
    // CsvEditorProvider.activeUri is process-lifetime static state; once
    // any earlier test in this run has opened a viewer it never resets to
    // undefined again. So this exercises "no *currently* relevant viewer"
    // (closeAllEditors just ran) rather than a truly pristine
    // never-opened-anything host — that pristine case is exercised for
    // csvViewer.open (not openAsText) in opening.itest.ts. Either way, the
    // command must not throw.
    await closeAllEditors();
    await vscode.commands.executeCommand("csvViewer.openAsText");
  });
});
