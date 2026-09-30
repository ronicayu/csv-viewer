// Covers: disposing a panel while its 300ms debounced reload timer is
// still pending (must not throw/error after dispose), and rapid
// open/close cycling for panel/listener leaks.
//
// Leak-check strategy: `panelCount()` mirrors testHookPanels.size, which
// is populated in resolveCustomTextEditor and deleted inside the SAME
// onDidDispose callback that disposes changeSub/viewStateSub/messageSub.
// So panelCount() returning to 0 after every close is a direct proxy for
// "onDidDispose actually fired and the per-panel listeners were disposed"
// — not just "the tab visually closed".

import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, sleep, waitFor, waitForRender } from "../helpers";

function fixture(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(WORKSPACE_ROOT, name));
}

suite("Disposal and leak checks", () => {
  suiteSetup(async () => {
    await getTestApi(); // ensures the extension is activated before any test in this file
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("closing the viewer while a debounced reload is pending causes no errors", async () => {
    const filePath = path.join(WORKSPACE_ROOT, "dispose-pending.csv");
    await fsp.writeFile(filePath, "id,val\n1,a\n");
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);
    const notifBefore = api.getNotifications().length;

    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, doc.lineAt(doc.lineCount - 1).range.end, "\n2,b");
    // This schedules the extension's 300ms debounce timer for a reload.
    await vscode.workspace.applyEdit(edit);

    // Close well before the 300ms debounce fires, exercising
    // webviewPanel.onDidDispose's `clearTimeout(changeDebounceHandle)`.
    await closeAllEditors();
    await waitFor(() => api.panelCount() === 0, { timeoutMs: 4000, message: "panel never reported disposed" });

    // Let the (should-be-cancelled) timer's original window pass, in case
    // it wasn't actually cleared and fires a postMessage into a disposed
    // webview.
    await sleep(800);

    assert.strictEqual(
      api.getNotifications().length,
      notifBefore,
      "expected no new error/warning notifications after disposing mid-debounce",
    );
  });

  test("rapidly opening and closing the same file 20 times leaves no panel/listener leak and no errors", async () => {
    const uri = fixture("live.csv");
    const api = await getTestApi();
    const notifBefore = api.getNotifications().length;

    for (let i = 0; i < 20; i++) {
      await openInViewer(uri);
      await waitFor(() => api.panelCount() >= 1, { timeoutMs: 4000, message: `panel never opened on iteration ${i}` });
      await closeAllEditors();
      await waitFor(() => api.panelCount() === 0, { timeoutMs: 4000, message: `panel never disposed on iteration ${i}` });
    }

    assert.strictEqual(api.panelCount(), 0, "expected zero live panels after 20 open/close cycles");
    assert.strictEqual(
      api.getNotifications().length,
      notifBefore,
      "expected no new notifications from 20 rapid open/close cycles",
    );
  });
});
