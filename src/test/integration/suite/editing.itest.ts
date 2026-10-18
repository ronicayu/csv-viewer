import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import {
  cellValue,
  closeAllEditors,
  editCell,
  fileKeyFor,
  getTestApi,
  openInViewer,
  sleep,
  viewerTab,
  waitFor,
  waitForCellValue,
  waitForRender,
  type CsvViewerTestApi,
} from "../helpers";

let counter = 0;

interface Opened {
  api: CsvViewerTestApi;
  uri: vscode.Uri;
  key: string;
  filePath: string;
}

async function openFixture(content: string | Buffer, name = "edit"): Promise<Opened> {
  counter += 1;
  // Own directory per test: back-to-back watchers on one directory were seen to silently drop events.
  const dir = path.join(WORKSPACE_ROOT, `editing-${name}-${counter}`);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.csv`);
  await fsp.writeFile(filePath, content);
  const uri = vscode.Uri.file(filePath);
  await openInViewer(uri);
  const api = await getTestApi();
  const key = fileKeyFor(uri);
  await waitForRender(api, key);
  return { api, uri, key, filePath };
}

async function revertAndWait({ api, key }: Opened): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await waitFor(() => api.getDocument(key)?.editCount === 0, { message: "revert never cleared the document's edits" });
}

const SIMPLE = "id,name,note\n1,Alice,hello\n2,Bob,world\n3,Carol,\n";

suite("Cell editing", function () {
  this.timeout(60000);

  suiteSetup(async () => {
    await getTestApi();
  });

  teardown(async () => {
    await vscode.workspace.getConfiguration("csvViewer").update("editing", undefined, vscode.ConfigurationTarget.Global);
    await closeAllEditors();
    const api = await getTestApi();
    await waitFor(() => api.panelCount() === 0, { timeoutMs: 5000, message: "panel never reported disposed in teardown" });
    await sleep(300);
  });

  test("an edit makes the document and its tab dirty", async () => {
    const opened = await openFixture(SIMPLE);
    const { api, uri, key } = opened;
    assert.strictEqual(api.getDocument(key)?.dirty, false);
    await editCell(api, key, 0, 1, "Alicia", 1);
    assert.strictEqual(api.getDocument(key)?.dirty, true);
    await waitFor(() => viewerTab(uri)?.isDirty === true, { message: "the tab never became dirty" });
    assert.deepStrictEqual(await cellValue(api, key, 0, 1), { value: "Alicia", edited: true });
    await revertAndWait(opened);
  });

  test("save writes exactly the spliced bytes: mixed CRLF/LF, BOM, blank lines, a short row, quoted fields and no final newline", async () => {
    const original = '﻿id,name,note\r\n1,"Smith, A",hello\n\n2,Bob\r\n3,"multi\nline",x';
    const opened = await openFixture(original, "splice");
    const { api, uri, key, filePath } = opened;

    await editCell(api, key, 0, 1, "Smith B", 1);
    await editCell(api, key, 1, 2, "added", 2);
    await vscode.commands.executeCommand("workbench.action.files.save");

    const expected = '﻿id,name,note\r\n1,Smith B,hello\n\n2,Bob,added\r\n3,"multi\nline",x';
    await waitFor(() => api.getDocument(key)?.dirty === false, { message: "the document stayed dirty after save" });
    assert.strictEqual((await fsp.readFile(filePath)).toString("utf8"), expected);
    assert.deepStrictEqual(Array.from(await fsp.readFile(filePath)), Array.from(Buffer.from(expected, "utf8")));
    await waitFor(() => viewerTab(uri)?.isDirty === false, { message: "the tab stayed dirty after save" });
    assert.strictEqual(api.getDocument(key)?.bytesLength, Buffer.byteLength(expected));
    assert.deepStrictEqual(await waitForCellValue(api, key, 0, 1, "Smith B"), { value: "Smith B", edited: false });
  });

  test("saving with no edits writes nothing", async () => {
    const { api, key, filePath } = await openFixture(SIMPLE, "noedit");
    const before = await fsp.stat(filePath);
    await vscode.commands.executeCommand("workbench.action.files.save");
    await sleep(500);
    const after = await fsp.stat(filePath);
    assert.strictEqual(after.mtimeMs, before.mtimeMs);
    assert.strictEqual(api.getDocument(key)?.baseVersion, 1);
  });

  test("undo makes the document dirty again without touching the file, redo re-applies, and the webview reflects both", async () => {
    const opened = await openFixture(SIMPLE, "undoredo");
    const { api, uri, key, filePath } = opened;
    await editCell(api, key, 1, 1, "Robert", 1);
    await vscode.commands.executeCommand("workbench.action.files.save");
    await waitFor(() => api.getDocument(key)?.dirty === false);
    const saved = await fsp.readFile(filePath, "utf8");
    assert.strictEqual(saved, "id,name,note\n1,Alice,hello\n2,Robert,world\n3,Carol,\n");
    const mtime = (await fsp.stat(filePath)).mtimeMs;

    await vscode.commands.executeCommand("undo");
    await waitFor(() => api.getDocument(key)?.dirty === true, { message: "undo after a save should re-dirty the document" });
    await waitFor(() => viewerTab(uri)?.isDirty === true);
    const undone = await waitForCellValue(api, key, 1, 1, "Bob");
    assert.deepStrictEqual(undone, { value: "Bob", edited: true });
    assert.strictEqual(await fsp.readFile(filePath, "utf8"), saved, "undo must not touch the file");
    assert.strictEqual((await fsp.stat(filePath)).mtimeMs, mtime);

    await vscode.commands.executeCommand("redo");
    await waitFor(() => api.getDocument(key)?.dirty === false, { message: "redo should return to the saved state" });
    await waitForCellValue(api, key, 1, 1, "Robert");
  });

  test("an edit undone after a save, then saved, writes the original record text back byte for byte", async () => {
    const opened = await openFixture(SIMPLE, "undosave");
    const { api, key, filePath } = opened;
    await editCell(api, key, 0, 2, "changed", 1);
    await vscode.commands.executeCommand("workbench.action.files.save");
    await waitFor(() => api.getDocument(key)?.dirty === false);
    await vscode.commands.executeCommand("undo");
    await waitFor(() => api.getDocument(key)?.dirty === true);
    await vscode.commands.executeCommand("workbench.action.files.save");
    await waitFor(() => api.getDocument(key)?.dirty === false);
    assert.strictEqual(await fsp.readFile(filePath, "utf8"), SIMPLE);
  });

  test("Revert File reloads from disk and clears the edits", async () => {
    const opened = await openFixture(SIMPLE, "revert");
    const { api, uri, key } = opened;
    await editCell(api, key, 0, 1, "Temp", 1);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    await waitFor(() => api.getDocument(key)?.editCount === 0);
    await waitFor(() => viewerTab(uri)?.isDirty === false);
    const cell = await waitForCellValue(api, key, 0, 1, "Alice");
    assert.deepStrictEqual(cell, { value: "Alice", edited: false });
  });

  test("saveDocumentAs writes the spliced bytes to a new path and leaves the source file untouched", async () => {
    const opened = await openFixture(SIMPLE, "saveas");
    const { api, key, filePath } = opened;
    await editCell(api, key, 2, 2, "filled", 1);
    const destination = path.join(path.dirname(filePath), "copy.csv");
    await api.saveDocumentAs(key, vscode.Uri.file(destination));
    assert.strictEqual(await fsp.readFile(destination, "utf8"), "id,name,note\n1,Alice,hello\n2,Bob,world\n3,Carol,filled\n");
    assert.strictEqual(await fsp.readFile(filePath, "utf8"), SIMPLE);
    await revertAndWait(opened);
  });

  test("a backup restores the edit count when the file is unchanged, and drops it with a warning when the file changed", async () => {
    const opened = await openFixture(SIMPLE, "backup");
    const { api, uri, key, filePath } = opened;
    await editCell(api, key, 0, 1, "Backed", 1);
    await editCell(api, key, 2, 2, "up", 2);
    const backupUri = vscode.Uri.file(path.join(path.dirname(filePath), "backup.json"));
    const backupId = await api.backupDocument(key, backupUri);

    const restored = await api.openDocumentFromBackup(uri, backupId);
    assert.strictEqual(restored.editCount, 2);

    await fsp.writeFile(filePath, SIMPLE + "4,Dave,new\n");
    const notificationsBefore = api.getNotifications().length;
    const dropped = await api.openDocumentFromBackup(uri, backupId);
    assert.strictEqual(dropped.editCount, 0);
    const warnings = api.getNotifications().slice(notificationsBefore).filter((n) => n.level === "warning");
    assert.ok(
      warnings.some((n) => n.message.includes(`the unsaved edits to "backup.csv" couldn't be restored because the file changed`)),
      `expected the restore warning, got ${JSON.stringify(warnings)}`,
    );
    // The live document sees the file change as a conflict, not a reload; discard its edits to close cleanly.
    await revertAndWait(opened);
  });

  test("an unreadable backup version is ignored", async () => {
    const opened = await openFixture(SIMPLE, "badbackup");
    const { api, uri, filePath } = opened;
    const backupUri = vscode.Uri.file(path.join(path.dirname(filePath), "backup.json"));
    await fsp.writeFile(backupUri.fsPath, JSON.stringify({ version: 99, records: [] }));
    const restored = await api.openDocumentFromBackup(uri, backupUri.toString());
    assert.strictEqual(restored.editCount, 0);
  });

  test("conflict: a change on disk while dirty shows fileChangedOnDisk without reloading; save asks, and Overwrite writes the original plus the edit", async () => {
    const opened = await openFixture(SIMPLE, "conflict");
    const { api, key, filePath } = opened;
    await editCell(api, key, 0, 1, "Mine", 1);
    const loadsBefore = api.getOutgoing(key).filter((m) => m.type === "load").length;

    await fsp.writeFile(filePath, "id,name,note\n1,Theirs,hello\n2,Bob,world\n3,Carol,\n4,New,row\n");
    await waitFor(() => api.getOutgoing(key).some((m) => m.type === "fileChangedOnDisk"), { timeoutMs: 8000, message: "no fileChangedOnDisk after an external change" });
    assert.strictEqual(api.getOutgoing(key).filter((m) => m.type === "load").length, loadsBefore, "a dirty document must not reload");

    const saving = Promise.resolve(vscode.commands.executeCommand("workbench.action.files.save"));
    await waitFor(() => api.getPendingPrompt() !== undefined, { message: "the overwrite prompt never appeared" });
    const prompt = api.getPendingPrompt()!;
    assert.ok(prompt.message.includes("has changed on disk since you opened it. Overwrite it with your edits?"), prompt.message);
    assert.deepStrictEqual(prompt.buttons, ["Overwrite"]);
    api.choosePromptButton("Overwrite");
    await saving;
    await waitFor(() => api.getDocument(key)?.dirty === false);
    assert.strictEqual(await fsp.readFile(filePath, "utf8"), "id,name,note\n1,Mine,hello\n2,Bob,world\n3,Carol,\n");
  });

  test("conflict: declining the overwrite fails the save and the document stays dirty", async () => {
    const opened = await openFixture(SIMPLE, "decline");
    const { api, key, filePath } = opened;
    await editCell(api, key, 0, 1, "Mine", 1);
    await fsp.writeFile(filePath, SIMPLE + "4,Dave,x\n");
    await waitFor(() => api.getOutgoing(key).some((m) => m.type === "fileChangedOnDisk"), { timeoutMs: 8000 });

    const saving = Promise.resolve(vscode.commands.executeCommand("workbench.action.files.save")).catch(() => undefined);
    await waitFor(() => api.getPendingPrompt() !== undefined);
    api.choosePromptButton(undefined);
    await saving;
    await sleep(300);
    assert.strictEqual(api.getDocument(key)?.dirty, true);
    assert.strictEqual(await fsp.readFile(filePath, "utf8"), SIMPLE + "4,Dave,x\n", "a declined save must not write");
    await revertAndWait(opened);
  });

  test("delete while dirty: fileDeleted, saving recreates the file, then fileRestored follows", async () => {
    const opened = await openFixture(SIMPLE, "deleted");
    const { api, key, filePath } = opened;
    await editCell(api, key, 0, 1, "Kept", 1);
    await fsp.unlink(filePath);
    await waitFor(() => api.getOutgoing(key).some((m) => m.type === "fileDeleted"), { timeoutMs: 8000, message: "no fileDeleted" });
    assert.ok(api.getNotifications().some((n) => /Your unsaved edits are kept; saving will recreate it/.test(n.message)));

    await vscode.commands.executeCommand("workbench.action.files.save");
    await waitFor(() => api.getDocument(key)?.dirty === false);
    assert.strictEqual(await fsp.readFile(filePath, "utf8"), "id,name,note\n1,Kept,hello\n2,Bob,world\n3,Carol,\n");
    await waitFor(() => api.getOutgoing(key).some((m) => m.type === "fileRestored"), { timeoutMs: 8000, message: "no fileRestored after the save recreated the file" });
  });

  test("a file that is not valid UTF-8 loads read-only with the encoding reason", async () => {
    const { api, key } = await openFixture(Buffer.from("name,note\ncaf\xe9,clich\xe9\n", "latin1"), "latin1");
    const load = api.getOutgoing(key).find((m) => m.type === "load") as { editable: boolean; readOnlyReason?: string } | undefined;
    assert.ok(load, "expected a load message");
    assert.strictEqual(load!.editable, false);
    assert.strictEqual(load!.readOnlyReason, "encoding");
  });

  test("csvViewer.editing: false loads with the setting reason, and flipping it posts setEditable", async () => {
    const config = vscode.workspace.getConfiguration("csvViewer");
    await config.update("editing", false, vscode.ConfigurationTarget.Global);
    const { api, key } = await openFixture(SIMPLE, "setting");
    const load = api.getOutgoing(key).find((m) => m.type === "load") as { editable: boolean; readOnlyReason?: string };
    assert.strictEqual(load.editable, false);
    assert.strictEqual(load.readOnlyReason, "setting");

    await config.update("editing", true, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => api.getOutgoing(key).some((m) => m.type === "setEditable" && m.editable === true),
      { timeoutMs: 8000, message: "no setEditable after enabling csvViewer.editing" },
    );
    await config.update("editing", false, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.getOutgoing(key).some((m) => m.type === "setEditable" && m.editable === false && m.readOnlyReason === "setting"), { timeoutMs: 8000 });
  });

  test("Open as Text is refused while the viewer has unsaved edits", async () => {
    const opened = await openFixture(SIMPLE, "astext");
    const { api, uri, key } = opened;
    await editCell(api, key, 0, 1, "Dirty", 1);
    const before = api.getNotifications().length;
    await vscode.commands.executeCommand("csvViewer.openAsText");
    await sleep(300);
    assert.ok(
      api.getNotifications().slice(before).some((n) => n.level === "warning" && n.message === "Save or revert your edits before opening as text."),
      "expected the refusal warning",
    );
    assert.ok(viewerTab(uri), "the viewer tab should still be there");
    await revertAndWait(opened);
  });

  test("closing a dirty viewer with revertAndCloseActiveEditor disposes the document and its watcher without notifications", async () => {
    const opened = await openFixture(SIMPLE, "close");
    const { api, key } = opened;
    await editCell(api, key, 0, 1, "Gone", 1);
    const before = api.getNotifications().length;
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await waitFor(() => api.panelCount() === 0, { timeoutMs: 8000, message: "the panel was never disposed" });
    await waitFor(() => api.getDocument(key) === undefined, { timeoutMs: 8000, message: "the document was never disposed" });
    assert.strictEqual(api.getNotifications().length, before);
  });

  test("a clean document still reloads on disk changes exactly as before", async () => {
    const { api, key, filePath } = await openFixture(SIMPLE, "clean");
    await fsp.writeFile(filePath, SIMPLE + "4,Dave,new\n");
    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[];
        return renders[renders.length - 1]?.rowCount === 4;
      },
      { timeoutMs: 8000, message: "a clean document never reloaded" },
    );
    assert.strictEqual(api.getDocument(key)?.baseVersion, 2);
  });
});
