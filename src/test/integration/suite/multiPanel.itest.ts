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
    await getTestApi();
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("same file open in a text editor and the viewer side by side: an unsaved edit in the text editor does NOT reload the viewer, but saving it does", async () => {
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

    await sleep(1000);
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
    // Render A before opening B: VS Code holds messages to a hidden webview until it is visible again.
    await openInViewer(uriA);
    await waitForRender(await getTestApi(), fileKeyFor(uriA));
    await openInViewer(uriB);

    const api = await getTestApi();
    const keyA = fileKeyFor(uriA);
    const keyB = fileKeyFor(uriB);
    const renderA = await waitForRender(api, keyA);
    const renderB = await waitForRender(api, keyB);

    assert.deepStrictEqual(renderA.headers, ["id", "name"]);
    assert.deepStrictEqual(renderB.headers, ["sku", "qty"]);
    assert.ok(api.panelCount() >= 2, `expected at least 2 live panels, got ${api.panelCount()}`);

    const allA = api.getMessages(keyA).filter((m) => m.type === "rendered") as { headers: string[] }[];
    const allB = api.getMessages(keyB).filter((m) => m.type === "rendered") as { headers: string[] }[];
    assert.ok(allA.every((r) => JSON.stringify(r.headers) === JSON.stringify(["id", "name"])));
    assert.ok(allB.every((r) => JSON.stringify(r.headers) === JSON.stringify(["sku", "qty"])));
  });

  test("delimiter state is keyed per file, not shared, verified through the real webview via a synthetic load", async () => {
    const uriA = fixture("fileA.csv");
    const uriB = fixture("fileB.csv");
    // Render A before opening B: VS Code holds messages to a hidden webview until it is visible again.
    await openInViewer(uriA);
    await waitForRender(await getTestApi(), fileKeyFor(uriA));
    await openInViewer(uriB);
    const api = await getTestApi();
    const keyA = fileKeyFor(uriA);
    const keyB = fileKeyFor(uriB);
    await waitForRender(api, keyA);
    await waitForRender(api, keyB);

    const textA = await fsp.readFile(path.join(WORKSPACE_ROOT, "fileA.csv"), "utf8");
    // Reopen A to bring it to the foreground: postMessage to a background webview is not delivered.
    await openInViewer(uriA);
    await sleep(500);
    const before = renderCount(api, keyA);

    const posted = api.postToWebview(keyA, {
      type: "load",
      fileKey: keyA,
      text: textA,
      state: { columnVisibility: {}, filterRules: [], quickSearch: "", sortKeys: [], firstRowIsHeader: true, pageSize: 100, delimiter: ";", quotes: true, markdownColumns: {} },
      defaultTableColumns: 8,
      defaultDelimiter: "",
      hintsSeen: [],
      testHooks: true,
    });
    assert.ok(posted, "postToWebview found no live panel for fileA");

    await waitFor(() => renderCount(api, keyA) > before, { message: "synthetic load for fileA never rendered" });
    const rendersA = api.getMessages(keyA).filter((m) => m.type === "rendered") as { headers: string[] }[];
    assert.strictEqual(rendersA[rendersA.length - 1].headers.length, 1, "forcing delimiter=';' on text with no semicolons should collapse to a single column");

    const rendersB = api.getMessages(keyB).filter((m) => m.type === "rendered") as { headers: string[] }[];
    assert.deepStrictEqual(rendersB[rendersB.length - 1].headers, ["sku", "qty"]);
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
    await sleep(1000);

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
    await waitForSaveState(api, oldKey);

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
    await closeAllEditors();
    await vscode.commands.executeCommand("csvViewer.openAsText");
  });
});
