// Covers docs/spec.md's live-reload behavior: the host debounces
// onDidChangeTextDocument by 300ms per panel and re-sends the whole
// document; the webview re-parses and keeps UI state. Also covers the two
// "the file moves under us" edge cases: replaced on disk, deleted on disk.

import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, renderCount, sleep, waitFor, waitForRender } from "../helpers";

function fixture(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(WORKSPACE_ROOT, name));
}

suite("Live reload", () => {
  suiteSetup(async () => {
    await getTestApi(); // ensures the extension is activated before any test in this file
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("50 rapid WorkspaceEdits are debounced: far fewer reloads than edits, final render matches the last edit", async () => {
    const uri = fixture("live.csv");
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    const initial = await waitForRender(api, key);
    assert.strictEqual(initial.rowCount, 2); // "id,val\n1,a\n2,b\n"

    const doc = await vscode.workspace.openTextDocument(uri);
    const before = renderCount(api, key);

    for (let i = 0; i < 50; i++) {
      const edit = new vscode.WorkspaceEdit();
      const endPos = doc.lineAt(doc.lineCount - 1).range.end;
      edit.insert(uri, endPos, `\n${100 + i},z${i}`);
      await vscode.workspace.applyEdit(edit);
    }

    // Let the trailing 300ms debounce flush, plus slack for the webview to
    // parse and post "rendered" back.
    await waitFor(
      () => {
        const renders = api.getMessages(key).filter((m) => m.type === "rendered") as { rowCount: number }[];
        const last = renders[renders.length - 1];
        return last !== undefined && last.rowCount === 52;
      },
      { timeoutMs: 8000, message: "final edit's content was never reflected in a rendered message" },
    );

    const reloadsCausedByEdits = renderCount(api, key) - before;
    // 50 edits landing within a handful of 300ms debounce windows should
    // coalesce into well under 50 reloads — assert it's not 1:1.
    assert.ok(
      reloadsCausedByEdits < 25,
      `expected debouncing to coalesce 50 edits into well under 25 reloads, got ${reloadsCausedByEdits}`,
    );
  });

  test("replacing the file on disk with fs.writeFile while open reloads it", async () => {
    const filePath = path.join(WORKSPACE_ROOT, "live-replace.csv");
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

  test("deleting the file on disk while open does not throw and the host stays responsive", async () => {
    const filePath = path.join(WORKSPACE_ROOT, "live-delete.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);
    const notificationsBefore = api.getNotifications().length;

    await fsp.unlink(filePath);
    await sleep(1500); // let VS Code's file watcher + our onDidChangeTextDocument settle

    // The real assertion is "nothing thrown" (an uncaught exception in the
    // extension host would fail this test run entirely) plus "the host is
    // still responsive" — proven by successfully running another command.
    await vscode.commands.executeCommand("workbench.action.files.saveAll");

    // No *new* error notification should have been surfaced by the delete
    // itself (best-effort proxy for "look at extension host log output":
    // the hook doesn't expose the raw Output channel, so absence of a new
    // error notification is the closest available signal).
    const notificationsAfter = api.getNotifications();
    const newErrors = notificationsAfter.slice(notificationsBefore).filter((n) => n.level === "error");
    assert.strictEqual(newErrors.length, 0, `unexpected error notification(s) after deleting the open file: ${JSON.stringify(newErrors)}`);
  });
});
