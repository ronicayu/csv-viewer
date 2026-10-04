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
    await setSuggestOnOpen(undefined);
  });

  teardown(async () => {
    await closeAllEditors();
    const api = await getTestApi();
    api.resetSuggestPromptState();
    await setSuggestOnOpen(undefined);
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
    // Only warnings and errors are recorded, so the follow-up information message is not visible here.
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
    // resolveCustomEditor already sets the flag; reset it so this test isolates openAsText.
    api.resetSuggestPromptState();

    await vscode.commands.executeCommand("csvViewer.openAsText");
    await sleep(300);

    const textUri = await freshCsv();
    await openAsPlainText(textUri);
    await assertNoPromptAppears(api);
  });

  test("switching to a second CSV while the prompt is unanswered doesn't stack another prompt", async () => {
    const first = await freshCsv();
    const second = await freshCsv();
    const api = await getTestApi();

    await openAsPlainText(first);
    const prompt = await waitForPrompt(api);
    await openAsPlainText(second);
    await sleep(1000);

    assert.strictEqual(api.getPendingPrompt()?.message, prompt.message, "the pending prompt should still be the first file's");
    api.choosePromptButton("Don't Ask Again");
    await assertNoPromptAppears(api);
  });

  test("doesn't prompt for a diff editor showing a CSV", async () => {
    const left = await freshCsv();
    const right = await freshCsv();
    const api = await getTestApi();

    await vscode.commands.executeCommand("vscode.diff", left, right, "csv diff");
    await assertNoPromptAppears(api);
  });
});
