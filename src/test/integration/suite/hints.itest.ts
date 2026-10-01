// Covers the per-user hint flag round trip (core/types.ts's HintSeenMessage
// and LoadMessage.hintsSeen, from globalState key `csvViewer.hintsSeen`).
// The real webview doesn't have a UI that sends `hintSeen` yet (that's the
// other half of this feature, owned by the webview team), so this
// exercises the host side directly via the test hook's
// simulateWebviewMessage — it runs the exact same onDidReceiveMessage
// handler a real webview message would, just without needing a webview
// control to click.

import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, waitFor, waitForRender } from "../helpers";

let fixtureCounter = 0;
/** A fresh, uniquely-named file each time, so its webview panel is
 * guaranteed to be newly created (and so actually sends `load`) rather
 * than potentially reusing an already-open panel some other suite left
 * behind for a shared fixture name. */
async function freshCsv(): Promise<vscode.Uri> {
  fixtureCounter += 1;
  const filePath = path.join(WORKSPACE_ROOT, `hints-itest-${fixtureCounter}.csv`);
  await fsp.writeFile(filePath, "id,name\n1,Alice\n2,Bob\n");
  return vscode.Uri.file(filePath);
}

suite("Per-user hint flags (hintSeen / load.hintsSeen)", () => {
  suiteSetup(async () => {
    await getTestApi();
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("a fresh load's hintsSeen never contains an id that hasn't been reported seen", async () => {
    const uri = await freshCsv();
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);
    assert.ok(!api.getHintsSeen().includes("itest-probe-hint"), "expected a never-before-seen id to be absent");
  });

  test("hintSeen round-trips into every future load's hintsSeen, for any file", async () => {
    const id = `itest-hint-${Date.now()}`;
    const uriA = await freshCsv();
    await openInViewer(uriA);
    const api = await getTestApi();
    const keyA = fileKeyFor(uriA);
    await waitForRender(api, keyA);

    const sent = api.simulateWebviewMessage(keyA, { type: "hintSeen", id });
    assert.ok(sent, "simulateWebviewMessage found no handler for fileA — is the panel open?");

    await waitFor(() => api.getHintsSeen().includes(id), { message: `expected "${id}" to be recorded in globalState's hintsSeen` });

    // A completely different, never-before-opened file's FIRST load also
    // carries it — the flag is per-user, not per-file.
    const uriB = await freshCsv();
    await openInViewer(uriB);
    const keyB = fileKeyFor(uriB);
    await waitForRender(api, keyB);
    const loadMessagesB = api.getOutgoing(keyB).filter((m) => m.type === "load") as { type: "load"; hintsSeen: string[] }[];
    assert.ok(loadMessagesB.length > 0, "expected at least one load message for fileB");
    assert.ok(loadMessagesB[loadMessagesB.length - 1].hintsSeen.includes(id), "expected fileB's load message to include the previously-seen hint id");
  });

  test("reporting the same hint id seen twice does not duplicate it", async () => {
    const id = `itest-hint-dup-${Date.now()}`;
    const uri = await freshCsv();
    await openInViewer(uri);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await waitForRender(api, key);

    api.simulateWebviewMessage(key, { type: "hintSeen", id });
    await waitFor(() => api.getHintsSeen().includes(id));
    api.simulateWebviewMessage(key, { type: "hintSeen", id });
    await new Promise((r) => setTimeout(r, 300));

    const occurrences = api.getHintsSeen().filter((x) => x === id).length;
    assert.strictEqual(occurrences, 1, `expected "${id}" to appear exactly once, got ${occurrences} times`);
  });
});
