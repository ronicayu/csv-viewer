import * as vscode from "vscode";
import { normalizePageSize } from "./core/paging";
import {
  createDefaultViewState,
  type HostToWebviewMessage,
  type ViewState,
  type WebviewToHostMessage,
} from "./core/types";

/** Injectable so tests can observe and answer the prompt: VS Code's real
 * `showInformationMessage` can't be driven by a click in the Extension
 * Test Host. Default implementation below is the real thing; the test
 * hook block swaps in a version that records the prompt and waits for
 * `choosePromptButton` instead of showing anything. */
type ShowPromptFn = (message: string, ...items: string[]) => Thenable<string | undefined>;
let showPrompt: ShowPromptFn = (message, ...items) => vscode.window.showInformationMessage(message, ...items);

const VIEW_TYPE = "csvViewer.table";
const STATE_PREFIX = "csvViewer.state:";
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
/** Hard ceiling: above this we refuse to load at all (see docs/spec.md). */
const HARD_LIMIT_BYTES = 512 * 1024 * 1024;
/** Debounce for re-reading and re-sending the file after it changes on
 * disk, so a burst of rapid writes (or a save that touches the file
 * multiple times) coalesces into one reload instead of one per write. */
const RELOAD_DEBOUNCE_MS = 300;
/** How long to wait after a delete event before treating the file as gone. */
const DELETE_GRACE_MS = 500;

/** globalState flag: once true, the first-run "View as a table?" prompt
 * (see maybeSuggestOpenAsTable) never shows again for this user, in any
 * workspace. Set on any prompt response (including dismissing with the X)
 * and also the moment the user demonstrates they already know the viewer
 * exists — opening it themselves (resolveCustomEditor runs for ANY
 * invocation path: the command, "Open With", or an editor association) or
 * using "Open as Text". */
const SUGGEST_DONE_KEY = "csvViewer.suggestOnOpen.done";
/** globalState key for the per-user set of one-time webview hint ids the
 * user has already dismissed (see HintSeenMessage / LoadMessage.hintsSeen
 * in core/types.ts). Lives on the host, not per-file, so a hint dismissed
 * once never resurfaces in any file. */
const HINTS_SEEN_KEY = "csvViewer.hintsSeen";

// ---- BEGIN TEST HOOK (CSV_VIEWER_TEST_HOOKS) ------------------------------
// Test-only instrumentation for src/test/integration. Completely inert
// (zero extra state, zero extra work, activate() returns undefined as
// normal) unless the extension host process has CSV_VIEWER_TEST_HOOKS=1 set
// — which only the integration test runner does. Nothing here changes
// production behavior for real users.
const TEST_HOOKS_ENABLED = process.env.CSV_VIEWER_TEST_HOOKS === "1";
/** fileKey (document.uri.toString()) -> live panel, for postToWebview(). */
const testHookPanels = new Map<string, vscode.WebviewPanel>();
/** fileKey -> the exact onDidReceiveMessage handler resolveCustomEditor
 * registered for that panel, so the test hook can simulate a
 * WebviewToHostMessage (like hintSeen) without needing a real webview to
 * send one — there's no in-test way to run code inside the actual webview
 * context the way the Playwright webview-e2e suite can. */
const testHookMessageHandlers = new Map<string, (message: WebviewToHostMessage) => void>();
/** fileKey -> every WebviewToHostMessage received so far, in order. */
const testHookMessages = new Map<string, WebviewToHostMessage[]>();
/** fileKey -> every HostToWebviewMessage the host has sent, in order (so
 * tests can assert on messages like fileDeleted/fileRestored that never
 * come back from the webview and so wouldn't show up in testHookMessages). */
const testHookOutgoing = new Map<string, HostToWebviewMessage[]>();
/** Every warning/error notification the extension has shown, in order. */
const testHookNotifications: { level: "warning" | "error"; message: string }[] = [];
/** The most recent first-run "View as a table?" prompt still awaiting a
 * response, plus the function to resolve it — set by the test-hook
 * showPrompt implementation, consumed by choosePromptButton(). */
let testHookPendingPrompt: { message: string; buttons: string[]; resolve: (choice: string | undefined) => void } | undefined;

export interface CsvViewerTestApi {
  /** Messages received from the webview for a given document, in order. */
  getMessages(fileKey: string): WebviewToHostMessage[];
  /** Messages the host has sent to a given document's webview, in order
   * (including ones no webview build acts on, like fileDeleted/fileRestored). */
  getOutgoing(fileKey: string): HostToWebviewMessage[];
  /** Post a message directly into a given document's live webview,
   * bypassing the UI. Returns false if no panel is open for that fileKey. */
  postToWebview(fileKey: string, message: HostToWebviewMessage): boolean;
  /** Feeds a message directly into a given document's onDidReceiveMessage
   * handler, as if the webview had sent it. Returns false if no panel
   * (and thus no handler) is registered for that fileKey. */
  simulateWebviewMessage(fileKey: string, message: WebviewToHostMessage): boolean;
  /** Warning/error messages shown via vscode.window.show*Message so far. */
  getNotifications(): { level: "warning" | "error"; message: string }[];
  /** Number of currently-live CSV Viewer panels (for disposal/leak checks). */
  panelCount(): number;
  /** Every `csvViewer.state:*` key currently in workspaceState, for
   * verifying the rename-migration behavior (see onDidRenameFiles below)
   * directly rather than only inferring it from webview messages. */
  getWorkspaceStateKeys(): string[];
  /** The first-run suggestion prompt currently awaiting a response (if
   * any), so a test can assert it appeared and read its exact copy. */
  getPendingPrompt(): { message: string; buttons: string[] } | undefined;
  /** Answers the pending prompt as if the user clicked `button` (must be
   * one of its `buttons`), or dismissed it (pass undefined, matching the
   * X button / Escape). Throws if there's no pending prompt. */
  choosePromptButton(button: string | undefined): void;
  /** The per-user hint ids currently recorded in globalState
   * (`csvViewer.hintsSeen`), for asserting hintSeen round-trips. */
  getHintsSeen(): string[];
  /** Clears the "never ask again" flag for the first-run suggestion prompt
   * (and drops any currently-pending prompt), so a test suite can exercise
   * the prompt more than once within the same Extension Test Host run
   * without it being permanently suppressed by an earlier test. Real users
   * never get this — it only exists for test isolation. */
  resetSuggestPromptState(): void;
}
// ---- END TEST HOOK setup ---------------------------------------------------

export function activate(context: vscode.ExtensionContext): CsvViewerTestApi | undefined {
  const provider = new CsvEditorProvider(context);

  if (TEST_HOOKS_ENABLED) {
    // Real showInformationMessage can't be clicked from the Extension Test
    // Host. Route the prompt through a recorder the test hook API can
    // observe and answer instead of actually showing anything.
    showPrompt = (message, ...buttons) =>
      new Promise<string | undefined>((resolve) => {
        testHookPendingPrompt = { message, buttons, resolve };
      });
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("csvViewer.open", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        const msg = "CSV Viewer: no file to open.";
        if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "error", message: msg });
        void vscode.window.showErrorMessage(msg);
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("csvViewer.openAsText", async () => {
      const uri = CsvEditorProvider.activeUri;
      if (!uri) return;
      // The user just used the explicit escape hatch back to plain text,
      // which demonstrates they already know the viewer exists — never
      // show the first-run suggestion prompt again (see
      // maybeSuggestOpenAsTable).
      void context.globalState.update(SUGGEST_DONE_KEY, true);
      await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    }),
  );

  // First-run discoverability (pm-review.md §3, option C): the first time a
  // .csv/.tsv/.tab file becomes the active *text* editor after install,
  // suggest opening it as a table. Needs `onStartupFinished` (declared in
  // package.json's activationEvents) plus this listener, since there's no
  // built-in language id to activate on for a plain CSV text document.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void maybeSuggestOpenAsTable(context, editor);
    }),
  );
  // Also check whatever's already active at activation time (e.g. a CSV
  // opened before the extension finished activating on startup).
  void maybeSuggestOpenAsTable(context, vscode.window.activeTextEditor);

  // Renaming a file (or a folder containing one) moves it to a new URI, but
  // per-file view state (column visibility, filters, sort, ...) is keyed by
  // the URI string in workspaceState. Without this, that state is silently
  // orphaned forever under the old key. Fires for both a single-file rename
  // and a folder rename (VS Code reports one {oldUri,newUri} pair for the
  // renamed folder itself, not one per descendant) — migrateWorkspaceState
  // handles both by also moving every key nested under the old prefix.
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((e) => {
      for (const { oldUri, newUri } of e.files) {
        migrateWorkspaceState(context, oldUri, newUri);
      }
    }),
  );

  if (TEST_HOOKS_ENABLED) {
    return {
      getMessages: (fileKey) => (testHookMessages.get(fileKey) ?? []).slice(),
      getOutgoing: (fileKey) => (testHookOutgoing.get(fileKey) ?? []).slice(),
      postToWebview: (fileKey, message) => {
        const panel = testHookPanels.get(fileKey);
        if (!panel) return false;
        void panel.webview.postMessage(message);
        return true;
      },
      simulateWebviewMessage: (fileKey, message) => {
        const handler = testHookMessageHandlers.get(fileKey);
        if (!handler) return false;
        handler(message);
        return true;
      },
      getNotifications: () => testHookNotifications.slice(),
      panelCount: () => testHookPanels.size,
      getWorkspaceStateKeys: () => context.workspaceState.keys().filter((k) => k.startsWith(STATE_PREFIX)),
      getPendingPrompt: () => (testHookPendingPrompt ? { message: testHookPendingPrompt.message, buttons: testHookPendingPrompt.buttons } : undefined),
      choosePromptButton: (button) => {
        if (!testHookPendingPrompt) throw new Error("choosePromptButton: no prompt is currently pending");
        const { resolve } = testHookPendingPrompt;
        testHookPendingPrompt = undefined;
        resolve(button);
      },
      getHintsSeen: () => context.globalState.get<string[]>(HINTS_SEEN_KEY, []),
      resetSuggestPromptState: () => {
        void context.globalState.update(SUGGEST_DONE_KEY, undefined);
        testHookPendingPrompt = undefined;
        suggestPromptInFlight = false;
      },
    };
  }
  return undefined;
}

export function deactivate(): void {
  // No teardown needed: everything is disposed via context.subscriptions
  // and per-panel listeners registered in resolveCustomEditor.
}

/** First-run discoverability prompt (pm-review.md §3, option C). Shows at
 * most once per user, ever: any response (including dismissing with the
 * X) permanently disables it via SUGGEST_DONE_KEY, and it's also disabled
 * the moment the user shows they already know the viewer exists (opening
 * it themselves, or using "Open as Text" — see resolveCustomEditor and the
 * openAsText command above). */
let suggestPromptInFlight = false;

async function maybeSuggestOpenAsTable(context: vscode.ExtensionContext, editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor) return;
  // One prompt at a time: switching to another CSV while the first prompt
  // is still unanswered must not stack a second one.
  if (suggestPromptInFlight) return;
  if (!vscode.workspace.getConfiguration("csvViewer").get<boolean>("suggestOnOpen", true)) return;
  if (context.globalState.get<boolean>(SUGGEST_DONE_KEY, false)) return;

  const uri = editor.document.uri;
  // Untitled documents have no real file path/extension to match; skip
  // them (and, with the same check, any other scheme with no real
  // extension — e.g. a diff editor's virtual document side, which also
  // won't match the extension regex below).
  if (uri.scheme === "untitled") return;
  if (!/\.(csv|tsv|tab)$/i.test(uri.path)) return;
  if (isViewerAlreadyOpenFor(uri)) return;
  // Only for a plain text tab. A diff editor's modified side is also an
  // active text editor with a file uri, but someone reviewing a diff isn't
  // asking to read the file as a table.
  const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(activeInput instanceof vscode.TabInputText) || activeInput.uri.toString() !== uri.toString()) return;

  const name = basename(uri);
  const OPEN_AS_TABLE = "Open as Table";
  const ALWAYS_FOR_CSV = "Always for CSV Files";
  const DONT_ASK_AGAIN = "Don't Ask Again";
  suggestPromptInFlight = true;
  let choice: string | undefined;
  try {
    choice = await showPrompt(`View "${name}" as a table?`, OPEN_AS_TABLE, ALWAYS_FOR_CSV, DONT_ASK_AGAIN);
  } finally {
    suggestPromptInFlight = false;
  }

  // Any response at all — including dismissing with the X, which resolves
  // to undefined — means never ask again.
  void context.globalState.update(SUGGEST_DONE_KEY, true);

  if (choice === OPEN_AS_TABLE) {
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  } else if (choice === ALWAYS_FOR_CSV) {
    await addCsvEditorAssociations();
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    void vscode.window.showInformationMessage(`CSV files will now open as tables. Use "Open as Text" in the editor title to go back.`);
  }
  // DONT_ASK_AGAIN (or a dismiss): nothing further to do.
}

/** Writes `workbench.editorAssociations` at user (global) scope, adding
 * *.csv/*.tsv/*.tab -> csvViewer.table while preserving every existing
 * entry (including one already covering an unrelated extension). */
async function addCsvEditorAssociations(): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const current = config.get<Record<string, string>>("workbench.editorAssociations") ?? {};
  const updated: Record<string, string> = { ...current, "*.csv": VIEW_TYPE, "*.tsv": VIEW_TYPE, "*.tab": VIEW_TYPE };
  await config.update("workbench.editorAssociations", updated, vscode.ConfigurationTarget.Global);
}

/** True if `uri` is already open in a csvViewer.table tab in any editor
 * group — used to avoid suggesting the viewer for a file the user has
 * already opened there (e.g. side-by-side with its text editor). */
function isViewerAlreadyOpenFor(uri: vscode.Uri): boolean {
  const target = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE && tab.input.uri.toString() === target) {
        return true;
      }
    }
  }
  return false;
}

/** Moves every workspaceState entry keyed under `oldUri` (exactly, or
 * nested under it as a folder prefix) to the equivalent key under
 * `newUri`, deleting the old key(s). A plain file rename only ever matches
 * the exact-key branch; a folder rename matches the nested-prefix branch
 * for every file that lived under it. */
function migrateWorkspaceState(context: vscode.ExtensionContext, oldUri: vscode.Uri, newUri: vscode.Uri): void {
  const oldKey = STATE_PREFIX + oldUri.toString();
  const oldFolderPrefix = oldKey + "/";
  const newKey = STATE_PREFIX + newUri.toString();

  for (const key of context.workspaceState.keys()) {
    let migratedKey: string | undefined;
    if (key === oldKey) migratedKey = newKey;
    else if (key.startsWith(oldFolderPrefix)) migratedKey = newKey + "/" + key.slice(oldFolderPrefix.length);
    if (migratedKey === undefined) continue;

    const value = context.workspaceState.get(key);
    void context.workspaceState.update(migratedKey, value);
    void context.workspaceState.update(key, undefined);
  }
}

/** Minimal CustomDocument for the readonly provider: just carries the uri.
 * All the real per-panel state (watcher, debounce timer, message/view-state
 * listeners) lives in resolveCustomEditor, scoped to the webviewPanel,
 * exactly as it did when this was a CustomTextEditorProvider. */
class CsvDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

class CsvEditorProvider implements vscode.CustomReadonlyEditorProvider<CsvDocument> {
  /** Tracks the most recently focused CSV Viewer panel's document, so the
   * "Open as Text" command (invokable outside the webview too) knows what
   * to act on. */
  static activeUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): CsvDocument {
    // No I/O here: VS Code no longer hands us a synced TextDocument (that's
    // exactly the bug this fixes — it never sent files >= its own text-sync
    // ceiling), so *we* read the bytes ourselves, in resolveCustomEditor,
    // where size checks and read failures can all go through the same
    // notification/test-hook pipeline.
    return new CsvDocument(uri);
  }

  async resolveCustomEditor(
    document: CsvDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "out", "webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webview.html = this.buildHtml(webview);

    const uri = document.uri;
    const fileKey = uri.toString();
    CsvEditorProvider.activeUri = uri;
    if (TEST_HOOKS_ENABLED) testHookPanels.set(fileKey, webviewPanel);
    // The viewer is actually open now, regardless of how it got here (the
    // command, "Open With", or an editor association) — the user
    // demonstrably knows it exists, so the first-run suggestion prompt
    // should never show again (see maybeSuggestOpenAsTable above). Skip
    // the write once it's already set, so repeatedly opening/closing the
    // viewer (as the disposal/multi-panel suites do, dozens of times)
    // doesn't re-persist the same value over and over.
    if (!this.context.globalState.get<boolean>(SUGGEST_DONE_KEY, false)) {
      void this.context.globalState.update(SUGGEST_DONE_KEY, true);
    }

    // Every message this panel sends to its webview goes through here so
    // the test hook can record it (see CsvViewerTestApi.getOutgoing) —
    // needed for messages like fileDeleted/fileRestored that the webview
    // never echoes back, so they'd otherwise be unobservable from a test.
    const send = (message: HostToWebviewMessage): void => {
      if (TEST_HOOKS_ENABLED) {
        const arr = testHookOutgoing.get(fileKey) ?? [];
        arr.push(message);
        testHookOutgoing.set(fileKey, arr);
      }
      void webview.postMessage(message);
    };

    // Tracks whether the webview currently believes the file is deleted
    // (see the watcher's onDidDelete handler below), so a later successful
    // reload can tell the webview the file came back.
    let isDeleted = false;

    // Reads the file fresh from disk via workspace.fs (works for files of
    // any size VS Code will let us stat/read, and outside the workspace,
    // and in untrusted/virtual workspaces — see docs/spec.md), decodes it,
    // and posts the same `load` message shape the webview has always
    // expected. Parsing still happens in the webview (unchanged).
    // Size + mtime of the bytes last posted. Watcher events that don't
    // change either (e.g. the create event a new watcher fires for an
    // existing file) are skipped instead of re-reading the whole file.
    let lastLoaded: { size: number; mtime: number } | undefined;
    let warnedLarge = false;

    const reportReadError = (err: unknown): void => {
      const msg = `CSV Viewer: could not read "${basename(uri)}": ${err instanceof Error ? err.message : String(err)}`;
      if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "error", message: msg });
      void vscode.window.showErrorMessage(msg);
    };

    /** `force` is set for the webview's `ready` request, which always needs
     * a load; watcher-driven reloads skip unchanged files. */
    const postLoad = async (force: boolean): Promise<void> => {
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch (err) {
        // On a watcher-driven reload this is usually transient (mid-write,
        // or raced with a delete, which onDidDelete handles). Only the
        // initial load has nothing else to show, so report it there.
        if (force) reportReadError(err);
        return;
      }
      if (!force && lastLoaded && lastLoaded.size === stat.size && lastLoaded.mtime === stat.mtime) return;

      if (stat.size > HARD_LIMIT_BYTES) {
        const msg = `CSV Viewer: "${basename(uri)}" is larger than 512 MB and was not loaded.`;
        if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "error", message: msg });
        void vscode.window.showErrorMessage(msg);
        return;
      }
      if (stat.size > LARGE_FILE_BYTES && !warnedLarge) {
        warnedLarge = true;
        const msg = `CSV Viewer: "${basename(uri)}" is larger than 50 MB. Loading it may be slow.`;
        if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "warning", message: msg });
        void vscode.window.showWarningMessage(msg);
      }

      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch (err) {
        if (force) reportReadError(err);
        return;
      }
      lastLoaded = { size: stat.size, mtime: stat.mtime };
      // BOM handling stays in parseCsv (src/core/csvParse.ts) — the decoder
      // here just turns bytes into a string.
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

      const state = this.loadOrCreateState(fileKey);
      const message: HostToWebviewMessage = {
        type: "load",
        fileKey,
        text,
        state,
        defaultTableColumns: this.defaultTableColumns(),
        defaultDelimiter: this.delimiterFor(uri) ?? "",
        hintsSeen: this.context.globalState.get<string[]>(HINTS_SEEN_KEY, []),
        testHooks: TEST_HOOKS_ENABLED,
      };
      send(message);

      if (isDeleted) {
        isDeleted = false;
        send({ type: "fileRestored" });
      }
    };

    // Live reload: watch exactly this file on disk (not the whole
    // workspace) — a non-recursive single-filename RelativePattern works
    // even for a file outside any open workspace folder. Deliberately NOT
    // wired to any "unsaved edit" signal: since resolveCustomEditor no
    // longer gets a synced TextDocument, an edit in a text editor that
    // hasn't been saved yet has no effect on the file on disk and so isn't
    // reflected here — see docs/spec.md / README ("Unsaved edits").
    const dirUri = vscode.Uri.joinPath(uri, "..");
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirUri, basename(uri)));

    let reloadDebounceHandle: ReturnType<typeof setTimeout> | undefined;
    const scheduleReload = (): void => {
      if (reloadDebounceHandle) clearTimeout(reloadDebounceHandle);
      reloadDebounceHandle = setTimeout(() => {
        reloadDebounceHandle = undefined;
        void postLoad(false);
      }, RELOAD_DEBOUNCE_MS);
    };

    const changeSub = watcher.onDidChange(scheduleReload);
    const createSub = watcher.onDidCreate(scheduleReload);
    // Editors with atomic saves (write temp file, delete, rename) produce a
    // delete immediately followed by a create, so check again after a short
    // grace period before telling the user the file is gone. Either way the
    // webview keeps showing the last loaded contents.
    let deleteCheckHandle: ReturnType<typeof setTimeout> | undefined;
    const deleteSub = watcher.onDidDelete(() => {
      if (reloadDebounceHandle) {
        clearTimeout(reloadDebounceHandle);
        reloadDebounceHandle = undefined;
      }
      if (deleteCheckHandle) clearTimeout(deleteCheckHandle);
      deleteCheckHandle = setTimeout(async () => {
        deleteCheckHandle = undefined;
        try {
          await vscode.workspace.fs.stat(uri);
          scheduleReload();
        } catch {
          const name = basename(uri);
          const msg = `CSV Viewer: "${name}" was deleted. Showing the last loaded contents.`;
          if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "warning", message: msg });
          void vscode.window.showWarningMessage(msg);
          isDeleted = true;
          send({ type: "fileDeleted", name });
        }
      }, DELETE_GRACE_MS);
    });

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) CsvEditorProvider.activeUri = uri;
    });

    const handleWebviewMessage = (message: WebviewToHostMessage): void => {
      if (TEST_HOOKS_ENABLED) {
        const arr = testHookMessages.get(fileKey) ?? [];
        arr.push(message);
        testHookMessages.set(fileKey, arr);
      }
      switch (message.type) {
        case "ready":
          void postLoad(true);
          break;
        case "saveState":
          this.saveState(fileKey, message.state);
          break;
        case "openAsText":
          void vscode.commands.executeCommand("vscode.openWith", uri, "default");
          break;
        case "hintSeen":
          this.markHintSeen(message.id);
          break;
      }
    };
    const messageSub = webview.onDidReceiveMessage(handleWebviewMessage);
    if (TEST_HOOKS_ENABLED) testHookMessageHandlers.set(fileKey, handleWebviewMessage);

    webviewPanel.onDidDispose(() => {
      if (reloadDebounceHandle) clearTimeout(reloadDebounceHandle);
      if (deleteCheckHandle) clearTimeout(deleteCheckHandle);
      changeSub.dispose();
      createSub.dispose();
      deleteSub.dispose();
      watcher.dispose();
      viewStateSub.dispose();
      messageSub.dispose();
      if (TEST_HOOKS_ENABLED) {
        testHookPanels.delete(fileKey);
        testHookMessageHandlers.delete(fileKey);
      }
    });
  }

  private defaultTableColumns(): number {
    return vscode.workspace.getConfiguration("csvViewer").get<number>("defaultTableColumns", 8);
  }

  private delimiterFor(uri: vscode.Uri): string | undefined {
    const path = uri.path.toLowerCase();
    if (path.endsWith(".tsv") || path.endsWith(".tab")) return "\t";
    return undefined;
  }

  private loadOrCreateState(fileKey: string): ViewState {
    const stored = this.context.workspaceState.get<ViewState>(STATE_PREFIX + fileKey);
    if (stored) {
      // Backward compatibility: state saved before pagination/separator
      // support existed may have no pageSize/delimiter (or, in principle, a
      // corrupted pageSize) — normalize rather than shipping `undefined`
      // down to the webview. Column visibility defaults are reconciled in
      // the webview once it knows the parsed headers.
      stored.pageSize = normalizePageSize(stored.pageSize);
      stored.delimiter = typeof stored.delimiter === "string" ? stored.delimiter : "";
      stored.quotes = typeof stored.quotes === "boolean" ? stored.quotes : true;
      return stored;
    }

    return createDefaultViewState();
  }

  private saveState(fileKey: string, state: ViewState): void {
    void this.context.workspaceState.update(STATE_PREFIX + fileKey, state);
  }

  /** Records a per-user hint id as seen (HintSeenMessage), globally (not
   * per-file), so it's included in every future `load`'s `hintsSeen` and
   * the webview never shows that hint again for this user. */
  private markHintSeen(id: string): void {
    const seen = this.context.globalState.get<string[]>(HINTS_SEEN_KEY, []);
    if (!seen.includes(id)) {
      void this.context.globalState.update(HINTS_SEEN_KEY, [...seen, id]);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "main.css"));
    // Parsing/filtering/sorting run in a Web Worker (out/webview/worker.js)
    // so a catastrophic regex or a large filter/sort never blocks the UI
    // thread — see docs/spec.md. A webview can't load a vscode-resource:
    // URL directly as a Worker script, so main.ts fetches this URI's text
    // (allowed by `connect-src` below) and loads it from a `blob:` URL
    // (allowed by `worker-src` below) instead.
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "worker.js"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `worker-src blob:`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>CSV Viewer</title>
</head>
<body>
<div id="app" data-worker-src="${workerUri}"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] ?? uri.path;
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
