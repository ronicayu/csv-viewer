import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, renderCount, sleep, waitFor, waitForRender } from "../helpers";

// Own directory per test: back-to-back watchers on one directory were seen to silently drop events.
async function freshDir(name: string): Promise<string> {
  const dir = path.join(WORKSPACE_ROOT, name);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

suite("Live reload", () => {
  suiteSetup(async () => {
    await getTestApi();
  });

  teardown(async () => {
    await closeAllEditors();
    // Wait for onDidDispose, which disposes the watcher; the close command resolving is not enough.
    const api = await getTestApi();
    await waitFor(() => api.panelCount() === 0, { timeoutMs: 5000, message: "panel never reported disposed in teardown" });
    // Settle time for the native watcher to be released; the next watcher can otherwise never fire.
    await sleep(500);
  });

  test("opening a file loads it exactly once (watcher start-up events don't trigger a second read)", async () => {
    const filePath = path.join(await freshDir("live-once-dir"), "live-once.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n2,b\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);
    // Longer than the reload debounce, so a spurious reload would have landed.
    await sleep(1500);
    assert.strictEqual(renderCount(api, key), 1, "expected exactly one render after opening an unchanged file");
  });

  test("an atomic save (delete, then recreate) reloads without a 'deleted' warning", async () => {
    const filePath = path.join(await freshDir("live-atomic-dir"), "live-atomic.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);
    const notificationsBefore = api.getNotifications().length;

    await fsp.unlink(filePath);
    await sleep(50);
    await fsp.writeFile(filePath, "id,val\n1,a\n2,b\n3,c\n");

    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[];
        return renders[renders.length - 1]?.rowCount === 3;
      },
      { timeoutMs: 8000, message: "the recreated file's content was never reflected" },
    );
    await sleep(800); // past the delete grace period
    const newNotes = api.getNotifications().slice(notificationsBefore).map((n) => n.message);
    assert.ok(!newNotes.some((m) => m.includes("deleted")), `unexpected notifications: ${JSON.stringify(newNotes)}`);
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

    for (let i = 0; i < 20; i++) {
      const rows = Array.from({ length: 2 + i }, (_, r) => `${r},row${i}`).join("\n");
      await fsp.writeFile(filePath, `id,val\n${rows}\n`);
    }
    const lastExpectedRowCount = 2 + 19;

    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[];
        const last = renders[renders.length - 1];
        return last !== undefined && last.rowCount === lastExpectedRowCount;
      },
      { timeoutMs: 8000, message: "the last write's content was never reflected in a rendered message" },
    );

    const reloadsCausedByWrites = renderCount(api, key) - before;
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

    // Second view column: the viewer's own column would replace its tab instead of opening side by side.
    // Opening the file as text can fire one spurious reload, so assert on content, not reload count.
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, doc.lineAt(doc.lineCount - 1).range.end, "\n3,c");
    await vscode.workspace.applyEdit(edit);
    assert.ok(doc.isDirty, "expected the document to be dirty after an unsaved edit");

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
    await sleep(200);

    await vscode.commands.executeCommand("workbench.action.files.saveAll");

    assert.strictEqual(renderCount(api, key), renderCountBeforeDelete, "deleting the file must not trigger a reload attempt");

    const newNotifications = api.getNotifications().slice(notificationsBefore);
    const newErrors = newNotifications.filter((n) => n.level === "error");
    assert.strictEqual(newErrors.length, 0, `unexpected error notification(s) after deleting the open file: ${JSON.stringify(newErrors)}`);

    const deletedWarning = newNotifications.find((n) => n.level === "warning" && /deleted/i.test(n.message) && /last loaded/i.test(n.message));
    assert.ok(deletedWarning, `expected a "File was deleted — showing last loaded contents" warning, got: ${JSON.stringify(newNotifications)}`);
    assert.ok(
      deletedWarning!.message.includes('"live-delete.csv"'),
      `expected the toast to name the file, got: ${deletedWarning!.message}`,
    );

    const outgoing = api.getOutgoing(key);
    const fileDeletedMsgs = outgoing.filter((m) => m.type === "fileDeleted") as { type: "fileDeleted"; name: string }[];
    assert.strictEqual(fileDeletedMsgs.length, 1, `expected exactly one fileDeleted message, got: ${JSON.stringify(fileDeletedMsgs)}`);
    assert.strictEqual(fileDeletedMsgs[0].name, "live-delete.csv");
  });

  test("a file reported deleted that later reappears triggers a reload plus a fileRestored message", async () => {
    const filePath = path.join(await freshDir("live-restore-dir"), "live-restore.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);

    await fsp.unlink(filePath);
    await waitFor(() => api.getOutgoing(key).some((m) => m.type === "fileDeleted"), {
      timeoutMs: 8000,
      message: "expected a fileDeleted message after deleting the open file",
    });

    await fsp.writeFile(filePath, "id,val\n1,a\n2,b\n3,c\n");
    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[];
        return renders[renders.length - 1]?.rowCount === 3;
      },
      { timeoutMs: 8000, message: "the recreated file's content was never reflected" },
    );

    const outgoing = api.getOutgoing(key);
    assert.strictEqual(outgoing.filter((m) => m.type === "fileRestored").length, 1, `expected exactly one fileRestored message, got: ${JSON.stringify(outgoing)}`);
  });
});
