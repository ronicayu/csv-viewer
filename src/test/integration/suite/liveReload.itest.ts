// Covers docs/spec.md's live-reload behavior for the readonly custom
// editor: a vscode.FileSystemWatcher on exactly the open file (so it works
// outside the workspace too), debounced 300ms per panel, re-reads the file
// via workspace.fs and re-posts `load`; the webview re-parses and keeps UI
// state. Also covers the file-moves-under-us edge cases (replaced, rapidly
// rewritten, deleted) and the deliberate "unsaved edits are not reflected"
// behavior (see docs/spec.md / README): since the provider reads bytes off
// disk itself instead of getting a synced TextDocument, only a write that
// actually lands on disk (i.e. a save) triggers a reload.

import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, renderCount, sleep, waitFor, waitForRender } from "../helpers";

/** Each test gets its own fresh subdirectory rather than sharing
 * WORKSPACE_ROOT directly. FOUND WHILE WRITING THIS SUITE (see final
 * report): rapidly creating and disposing several
 * vscode.FileSystemWatchers that all target the *same* directory (one per
 * test, back-to-back) was observed to silently drop a subsequent watcher's
 * events entirely in this environment — no error, it just never fires,
 * even waiting several seconds. Scoping each test to its own directory
 * sidesteps that watcher-churn race; it doesn't affect the real-world
 * behavior being tested (a single file's own watcher, for as long as its
 * viewer is open, is unaffected either way). */
async function freshDir(name: string): Promise<string> {
  const dir = path.join(WORKSPACE_ROOT, name);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

suite("Live reload", () => {
  suiteSetup(async () => {
    await getTestApi(); // ensures the extension is activated before any test in this file
  });

  teardown(async () => {
    await closeAllEditors();
    // Wait for the disposed panel's onDidDispose to actually run (not just
    // the close command's promise to resolve) — that's what disposes this
    // suite's FileSystemWatcher. Without this, the next test's watcher for
    // a *different* file in the same directory can be created while the
    // previous one's teardown is still in flight, which was observed to
    // silently swallow that new watcher's events (see final report).
    const api = await getTestApi();
    await waitFor(() => api.panelCount() === 0, { timeoutMs: 5000, message: "panel never reported disposed in teardown" });
    // Extra settle time for the native FileSystemWatcher resource behind
    // the disposed watcher to actually be released — see freshDir's
    // comment above; without this, creating this suite's *next* watcher
    // too soon after the previous one's dispose was observed to silently
    // never fire in this environment (no error, just no events, even
    // waiting 8+ seconds for one).
    await sleep(500);
  });

  test("20 rapid on-disk writes are debounced: far fewer reloads than writes, final render matches the last write", async () => {
    const filePath = path.join(await freshDir("live-rapid-dir"), "live-rapid.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n2,b\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    const initial = await waitForRender(api, key);
    assert.strictEqual(initial.rowCount, 2);

    const before = renderCount(api, key);

    // 20 quick, real writes to the same file on disk (no WorkspaceEdit / no
    // text-document model involved at all — this provider never sees one).
    for (let i = 0; i < 20; i++) {
      const rows = Array.from({ length: 2 + i }, (_, r) => `${r},row${i}`).join("\n");
      await fsp.writeFile(filePath, `id,val\n${rows}\n`);
    }
    const lastExpectedRowCount = 2 + 19; // the 20th (last) write's row count

    // Let the trailing 300ms debounce flush, plus slack for the read +
    // webview parse + "rendered" reply.
    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[];
        const last = renders[renders.length - 1];
        return last !== undefined && last.rowCount === lastExpectedRowCount;
      },
      { timeoutMs: 8000, message: "the last write's content was never reflected in a rendered message" },
    );

    const reloadsCausedByWrites = renderCount(api, key) - before;
    // 20 writes landing within a handful of 300ms debounce windows should
    // coalesce into well under 20 reloads — assert it's not 1:1.
    assert.ok(
      reloadsCausedByWrites < 10,
      `expected debouncing to coalesce 20 writes into well under 10 reloads, got ${reloadsCausedByWrites}`,
    );
  });

  test("replacing the file on disk with fs.writeFile while open reloads it", async () => {
    const filePath = path.join(await freshDir("live-replace-dir"), "live-replace.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    const initial = await waitForRender(api, key);
    assert.strictEqual(initial.rowCount, 1);

    await fsp.writeFile(filePath, "id,val,extra\n1,a,x\n2,b,y\n3,c,z\n");

    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number; headers: string[] }[];
        const last = renders[renders.length - 1];
        return last !== undefined && last.rowCount === 3;
      },
      { timeoutMs: 8000, message: "replacing the file on disk never triggered a reload reflecting the new content" },
    );
  });

  test("an unsaved edit in a text editor does NOT reload the viewer, but saving it does", async () => {
    const filePath = path.join(await freshDir("live-unsaved-dir"), "live-unsaved.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n2,b\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    const initial = await waitForRender(api, key);
    assert.strictEqual(initial.rowCount, 2);

    // A different view column from the viewer's, like multiPanel.itest.ts's
    // side-by-side test — showing the text editor in the *same* column the
    // viewer occupies would replace that tab (closing the custom editor)
    // instead of opening side by side.
    //
    // SURPRISE (see final report): merely opening this file a *second*
    // time as a plain text document (openTextDocument/showTextDocument),
    // while our FileSystemWatcher on it is already live, reliably fires
    // one spurious onDidChange/onDidCreate-style event in this environment
    // — even though nothing touched the file's bytes. It shows up here as
    // one extra "rendered" message with the file's unchanged 2-row content
    // (confirmed by instrumenting this test while diagnosing it). It's
    // most likely VS Code's own text-file resolution doing a stat/open on
    // the file that some backend (macOS FSEvents in this run) reports as a
    // metadata change. Rather than assert an exact reload count (which
    // this makes flaky/order-dependent — see multiPanel.itest.ts's
    // sibling test, which doesn't hit it only because its custom editor
    // opens *after* its text editor), this test asserts the behavior that
    // actually matters: whatever reloads happen, none of them ever show
    // the unsaved edit's content until it's actually saved.
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, doc.lineAt(doc.lineCount - 1).range.end, "\n3,c");
    await vscode.workspace.applyEdit(edit);
    assert.ok(doc.isDirty, "expected the document to be dirty after an unsaved edit");

    // Give any reload (spurious or not) a chance to settle.
    await sleep(1000);
    const rowCountsSoFar = (api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[]).map((m) => m.rowCount);
    assert.ok(
      rowCountsSoFar.every((n) => n === 2),
      `an unsaved edit must never be reflected before a save; saw rendered rowCounts ${JSON.stringify(rowCountsSoFar)}`,
    );

    await doc.save();

    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[];
        const last = renders[renders.length - 1];
        return last !== undefined && last.rowCount === 3;
      },
      { timeoutMs: 6000, message: "saving the file never reloaded the viewer" },
    );
  });

  test("deleting the file on disk while open shows a non-modal warning, keeps the last-loaded contents, and does not throw", async () => {
    const filePath = path.join(await freshDir("live-delete-dir"), "live-delete.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    const initial = await waitForRender(api, key);
    assert.strictEqual(initial.rowCount, 1);
    const renderCountBeforeDelete = renderCount(api, key);
    const notificationsBefore = api.getNotifications().length;

    await fsp.unlink(filePath);
    await waitFor(() => api.getNotifications().length > notificationsBefore, {
      timeoutMs: 8000,
      message: "expected a new notification after deleting the open file",
    });
    await sleep(200); // small settle margin in case anything else is still landing

    // The real assertions: nothing thrown (an uncaught exception in the
    // extension host would fail this test run entirely), the host is still
    // responsive, the decided warning was shown, and — since there's
    // nothing to re-read — no reload was attempted, so the last-loaded
    // contents are still what's recorded.
    await vscode.commands.executeCommand("workbench.action.files.saveAll");

    assert.strictEqual(renderCount(api, key), renderCountBeforeDelete, "deleting the file must not trigger a reload attempt");

    const newNotifications = api.getNotifications().slice(notificationsBefore);
    const newErrors = newNotifications.filter((n) => n.level === "error");
    assert.strictEqual(newErrors.length, 0, `unexpected error notification(s) after deleting the open file: ${JSON.stringify(newErrors)}`);

    const deletedWarning = newNotifications.find((n) => n.level === "warning" && /deleted/i.test(n.message) && /last loaded/i.test(n.message));
    assert.ok(deletedWarning, `expected a "File was deleted — showing last loaded contents" warning, got: ${JSON.stringify(newNotifications)}`);
  });
});
