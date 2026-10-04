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
    await getTestApi();
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

    // Real disk write: the FileSystemWatcher does not react to an unsaved WorkspaceEdit.
    await fsp.writeFile(filePath, "id,val\n1,a\n2,b\n");

    await closeAllEditors();
    await waitFor(() => api.panelCount() === 0, { timeoutMs: 4000, message: "panel never reported disposed" });

    // Wait past the 300ms debounce so a timer that was not cleared would have fired by now.
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
