// Covers csvViewer.defaultTableColumns edge cases: 0, 1, 1000, negative,
// and a non-number value. Uses the fact that a fresh file's first open
// triggers an automatic saveState (see multiPanel.itest.ts), whose
// `state.columnVisibility` is the real, host-observable result of
// `reconcileVisibility` — not just "did it crash".

import * as assert from "assert";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { WORKSPACE_ROOT } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, waitForRender, waitForSaveState } from "../helpers";

const CONFIG_SECTION = "csvViewer";
const CONFIG_KEY = "defaultTableColumns";
const COLUMNS = ["a", "b", "c", "d", "e", "f", "g"]; // columns7.csv

async function setDefaultTableColumns(value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_KEY, value, vscode.ConfigurationTarget.Global);
}

let fixtureCounter = 0;

/** Writes a brand-new copy of the 7-column fixture under a unique name so
 * each case gets a genuinely fresh fileKey (no prior persisted state to
 * interfere with reconciliation). */
async function freshColumnsFixture(): Promise<vscode.Uri> {
  fixtureCounter += 1;
  const filePath = path.join(WORKSPACE_ROOT, `columns7-case-${fixtureCounter}.csv`);
  await fsp.writeFile(filePath, "a,b,c,d,e,f,g\n1,2,3,4,5,6,7\n");
  return vscode.Uri.file(filePath);
}

async function visibleCountFor(value: unknown): Promise<{ visibility: Record<string, boolean>; visibleCount: number }> {
  await setDefaultTableColumns(value);
  const uri = await freshColumnsFixture();
  await openInViewer(uri);
  const api = await getTestApi();
  const key = fileKeyFor(uri);
  await waitForRender(api, key);
  const saveState = await waitForSaveState(api, key);
  const visibility = saveState.state.columnVisibility;
  const visibleCount = COLUMNS.filter((c) => visibility[c] !== false).length;
  return { visibility, visibleCount };
}

suite("csvViewer.defaultTableColumns edge cases", () => {
  suiteTeardown(async () => {
    await setDefaultTableColumns(undefined); // reset to the schema default (8)
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("0: every column starts detail-only", async () => {
    const { visibleCount } = await visibleCountFor(0);
    assert.strictEqual(visibleCount, 0);
  });

  test("1: only the first column starts in the table", async () => {
    const { visibility } = await visibleCountFor(1);
    assert.strictEqual(visibility["a"], true);
    for (const c of ["b", "c", "d", "e", "f", "g"]) assert.strictEqual(visibility[c], false);
  });

  test("1000 (larger than the column count): every column starts in the table", async () => {
    const { visibleCount } = await visibleCountFor(1000);
    assert.strictEqual(visibleCount, COLUMNS.length);
  });

  test("negative: does not throw, degrades to 'every column detail-only' (i < negative is always false)", async () => {
    const { visibleCount } = await visibleCountFor(-3);
    assert.strictEqual(visibleCount, 0);
  });

  test("non-number ('banana'): does not throw, degrades to 'every column detail-only' (i < NaN-like is always false)", async () => {
    // package.json declares defaultTableColumns as type:"number", but
    // `workspace.getConfiguration().update()` and `.get()` don't enforce
    // that schema at the API level — a malformed value from a hand-edited
    // settings.json flows straight into defaultVisibility()'s `i < N`
    // comparison. This documents that it degrades gracefully rather than
    // throwing, not that it's a *good* user experience (VS Code's Settings
    // UI would normally stop a user from typing this in directly).
    const { visibleCount } = await visibleCountFor("banana");
    assert.strictEqual(visibleCount, 0);
  });
});
