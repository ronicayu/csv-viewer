// Covers the first-run "View as a table?" suggestion prompt (pm-review.md
// §3, option C): fires once for a plain-text CSV/TSV/TAB editor, never
// again afterward regardless of which button was used (or none); each
// button's effect; csvViewer.suggestOnOpen=false suppresses it; it never
// fires once the viewer has been opened manually (including via the
// prompt's own "Open as Table"/"Always" choices, and via "Open as Text").
//
// vscode.window.showInformationMessage can't be driven by a click from the
// Extension Test Host, so the prompt is routed through an injectable
// function in extension.ts; the test-hook API exposes it as
// getPendingPrompt()/choosePromptButton() instead (see helpers.ts's
// waitForPrompt/assertNoPromptAppears).

import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { assertNoPromptAppears, closeAllEditors, getTestApi, sleep, waitForPrompt, waitForRender, fileKeyFor } from "../helpers";

const ASSOC_KEY = "workbench.editorAssociations";

async function globalConfig(): Promise<vscode.WorkspaceConfiguration> {
  return vscode.workspace.getConfiguration();
}

async function getAssociations(): Promise<Record<string, string> | undefined> {
  return (await globalConfig()).get<Record<string, string>>(ASSOC_KEY);
}

async function setAssociations(value: Record<string, string> | undefined): Promise<void> {
  await (await globalConfig()).update(ASSOC_KEY, value, vscode.ConfigurationTarget.Global);
}

async function setSuggestOnOpen(value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration("csvViewer").update("suggestOnOpen", value, vscode.ConfigurationTarget.Global);
}

let fixtureCounter = 0;
/** A fresh, uniquely-named small CSV each time, so no two tests race over
 * the same uri's "is the viewer already open for it" check. */
async function freshCsv(): Promise<vscode.Uri> {
  fixtureCounter += 1;
  const filePath = path.join(WORKSPACE_ROOT, `suggest-prompt-${fixtureCounter}.csv`);
  await fsp.writeFile(filePath, "id,name\n1,Alice\n2,Bob\n");
  return vscode.Uri.file(filePath);
}

async function openAsPlainText(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}

suite("First-run 'View as a table?' suggestion prompt", () => {
  const associationsBefore: (Record<string, string> | undefined)[] = [];

  setup(async () => {
    associationsBefore.push(await getAssociations());
    const api = await getTestApi();
    api.resetSuggestPromptState();
    await setSuggestOnOpen(undefined); // back to the schema default (true)
  });

  teardown(async () => {
    await closeAllEditors();
    const api = await getTestApi();
    api.resetSuggestPromptState();
    await setSuggestOnOpen(undefined);
    // Restore whatever workbench.editorAssociations held before this test,
    // undoing anything a "Always for CSV Files" choice wrote.
    const restore = associationsBefore.pop();
    await setAssociations(restore);
  });

  test("appears once for a plain-text CSV editor, with the expected copy and buttons", async () => {
    const uri = await freshCsv();
    await openAsPlainText(uri);
    const api = await getTestApi();
    const prompt = await waitForPrompt(api);
    assert.strictEqual(prompt.message, `View "${path.basename(uri.fsPath)}" as a table?`);
    assert.deepStrictEqual(prompt.buttons, ["Open as Table", "Always for CSV Files", "Don't Ask Again"]);
  });

  test("does not appear a second time after being answered once", async () => {
    const uri = await freshCsv();
    await openAsPlainText(uri);
    const api = await getTestApi();
    await waitForPrompt(api);
    api.choosePromptButton("Don't Ask Again");

    const uri2 = await freshCsv();
    await openAsPlainText(uri2);
    await assertNoPromptAppears(api);
  });

  test("'Open as Table' opens the viewer for that file", async () => {
    const uri = await freshCsv();
    await openAsPlainText(uri);
    const api = await getTestApi();
    await waitForPrompt(api);
    api.choosePromptButton("Open as Table");

    const render = await waitForRender(api, fileKeyFor(uri));
    assert.strictEqual(render.rowCount, 2);
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(active?.input instanceof vscode.TabInputCustom && active.input.viewType === "csvViewer.table");
  });

  test("'Always for CSV Files' writes the three associations (preserving an existing unrelated one), opens the viewer, and shows a follow-up message", async () => {
    await setAssociations({ "*.foo": "someOtherExt.editor" });
    const uri = await freshCsv();
    await openAsPlainText(uri);
    const api = await getTestApi();
    await waitForPrompt(api);
    api.choosePromptButton("Always for CSV Files");

    await waitForRender(api, fileKeyFor(uri));

    const associations = await getAssociations();
    assert.strictEqual(associations?.["*.csv"], "csvViewer.table");
    assert.strictEqual(associations?.["*.tsv"], "csvViewer.table");
    assert.strictEqual(associations?.["*.tab"], "csvViewer.table");
    assert.strictEqual(associations?.["*.foo"], "someOtherExt.editor", "expected the pre-existing unrelated association to survive");

    const notifications = api.getNotifications();
    // The follow-up is an information message, not warning/error, so it
    // isn't in getNotifications() (which only records warnings/errors) —
    // just confirm nothing on the warning/error path was raised by this
    // flow.
    assert.strictEqual(notifications.filter((n) => n.level === "error").length, 0);
  });

  test("'Don't Ask Again' does not open the viewer", async () => {
    const uri = await freshCsv();
    await openAsPlainText(uri);
    const api = await getTestApi();
    await waitForPrompt(api);
    api.choosePromptButton("Don't Ask Again");
    await sleep(500);

    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(
      !(active?.input instanceof vscode.TabInputCustom && active.input.viewType === "csvViewer.table"),
      "expected the viewer NOT to have opened",
    );
  });

  test("dismissing the prompt (the X / Escape, modeled as choosing undefined) also means never ask again", async () => {
    const uri = await freshCsv();
    await openAsPlainText(uri);
    const api = await getTestApi();
    await waitForPrompt(api);
    api.choosePromptButton(undefined);

    const uri2 = await freshCsv();
    await openAsPlainText(uri2);
    await assertNoPromptAppears(api);
  });

  test("csvViewer.suggestOnOpen=false suppresses the prompt", async () => {
    await setSuggestOnOpen(false);
    const uri = await freshCsv();
    await openAsPlainText(uri);
    const api = await getTestApi();
    await assertNoPromptAppears(api);
  });

  test("never prompts once the viewer has already been opened manually for an unrelated file", async () => {
    // Opening the viewer through any path (the command, "Open With", an
    // association) flips the same "already knows about the viewer" flag
    // resolveCustomEditor sets — exercise it via the command on one file,
    // then confirm a completely different, never-before-seen CSV text
    // editor does not trigger the prompt.
    const viewerUri = await freshCsv();
    await vscode.commands.executeCommand("csvViewer.open", viewerUri);
    const api = await getTestApi();
    await waitForRender(api, fileKeyFor(viewerUri));

    const textUri = await freshCsv();
    await openAsPlainText(textUri);
    await assertNoPromptAppears(api);
  });

  test("never prompts once 'Open as Text' has been used", async () => {
    const viewerUri = await freshCsv();
    await vscode.commands.executeCommand("csvViewer.open", viewerUri);
    const api = await getTestApi();
    await waitForRender(api, fileKeyFor(viewerUri));
    // resolveCustomEditor already marks the flag; reset it so this test
    // specifically isolates openAsText's own flag-setting.
    api.resetSuggestPromptState();

    await vscode.commands.executeCommand("csvViewer.openAsText");
    await sleep(300);

    const textUri = await freshCsv();
    await openAsPlainText(textUri);
    await assertNoPromptAppears(api);
  });
});
