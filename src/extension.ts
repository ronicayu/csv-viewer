import * as vscode from "vscode";
import { normalizeColumnFlags } from "./core/columns";
import { normalizePageSize } from "./core/paging";
import {
  createDefaultViewState,
  type HostToWebviewMessage,
  type ViewState,
  type WebviewToHostMessage,
} from "./core/types";

// Reassignable so the test hook can answer the prompt; a real notification can't be clicked in tests.
type ShowPromptFn = (message: string, ...items: string[]) => Thenable<string | undefined>;
let showPrompt: ShowPromptFn = (message, ...items) => vscode.window.showInformationMessage(message, ...items);

const VIEW_TYPE = "csvViewer.table";
const STATE_PREFIX = "csvViewer.state:";
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const HARD_LIMIT_BYTES = 512 * 1024 * 1024;
const RELOAD_DEBOUNCE_MS = 300;
const DELETE_GRACE_MS = 500;

const SUGGEST_DONE_KEY = "csvViewer.suggestOnOpen.done";
const HINTS_SEEN_KEY = "csvViewer.hintsSeen";

const TEST_HOOKS_ENABLED = process.env.CSV_VIEWER_TEST_HOOKS === "1";
const testHookPanels = new Map<string, vscode.WebviewPanel>();
const testHookMessageHandlers = new Map<string, (message: WebviewToHostMessage) => void>();
const testHookMessages = new Map<string, WebviewToHostMessage[]>();
const testHookOutgoing = new Map<string, HostToWebviewMessage[]>();
const testHookNotifications: { level: "warning" | "error"; message: string }[] = [];
let testHookPendingPrompt: { message: string; buttons: string[]; resolve: (choice: string | undefined) => void } | undefined;

export interface CsvViewerTestApi {
  getMessages(fileKey: string): WebviewToHostMessage[];
  getOutgoing(fileKey: string): HostToWebviewMessage[];
  postToWebview(fileKey: string, message: HostToWebviewMessage): boolean;
  simulateWebviewMessage(fileKey: string, message: WebviewToHostMessage): boolean;
  getNotifications(): { level: "warning" | "error"; message: string }[];
  panelCount(): number;
  getWorkspaceStateKeys(): string[];
  getPendingPrompt(): { message: string; buttons: string[] } | undefined;
  choosePromptButton(button: string | undefined): void;
  getHintsSeen(): string[];
  resetSuggestPromptState(): void;
}

export function activate(context: vscode.ExtensionContext): CsvViewerTestApi | undefined {
  const provider = new CsvEditorProvider(context);

  if (TEST_HOOKS_ENABLED) {
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
      // Using "Open as Text" shows the user knows the viewer exists, so stop suggesting it.
      void context.globalState.update(SUGGEST_DONE_KEY, true);
      await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    }),
  );

  // A plain CSV document has no language id to activate on; onStartupFinished plus this listener covers it.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void maybeSuggestOpenAsTable(context, editor);
    }),
  );
  void maybeSuggestOpenAsTable(context, vscode.window.activeTextEditor);

  // View state is keyed by URI, so a file or folder rename must move it or it is orphaned.
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
}

let suggestPromptInFlight = false;

async function maybeSuggestOpenAsTable(context: vscode.ExtensionContext, editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor) return;
  if (suggestPromptInFlight) return;
  if (!vscode.workspace.getConfiguration("csvViewer").get<boolean>("suggestOnOpen", true)) return;
  if (context.globalState.get<boolean>(SUGGEST_DONE_KEY, false)) return;

  const uri = editor.document.uri;
  if (uri.scheme === "untitled") return;
  if (!/\.(csv|tsv|tab)$/i.test(uri.path)) return;
  if (isViewerAlreadyOpenFor(uri)) return;
  // A diff editor's modified side is also an active text editor with a file uri; skip it.
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

  void context.globalState.update(SUGGEST_DONE_KEY, true);

  if (choice === OPEN_AS_TABLE) {
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  } else if (choice === ALWAYS_FOR_CSV) {
    await addCsvEditorAssociations();
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    void vscode.window.showInformationMessage(`CSV files will now open as tables. Use "Open as Text" in the editor title to go back.`);
  }
}

async function addCsvEditorAssociations(): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const current = config.get<Record<string, string>>("workbench.editorAssociations") ?? {};
  const updated: Record<string, string> = { ...current, "*.csv": VIEW_TYPE, "*.tsv": VIEW_TYPE, "*.tab": VIEW_TYPE };
  await config.update("workbench.editorAssociations", updated, vscode.ConfigurationTarget.Global);
}

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

class CsvDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

class CsvEditorProvider implements vscode.CustomReadonlyEditorProvider<CsvDocument> {
  static activeUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): CsvDocument {
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
    // Opening the viewer by any route means the user knows it exists, so the first-run prompt stops.
    if (!this.context.globalState.get<boolean>(SUGGEST_DONE_KEY, false)) {
      void this.context.globalState.update(SUGGEST_DONE_KEY, true);
    }

    const send = (message: HostToWebviewMessage): void => {
      if (TEST_HOOKS_ENABLED) {
        const arr = testHookOutgoing.get(fileKey) ?? [];
        arr.push(message);
        testHookOutgoing.set(fileKey, arr);
      }
      void webview.postMessage(message);
    };

    let isDeleted = false;

    // Skips watcher events that change neither size nor mtime, e.g. a new watcher's create event.
    let lastLoaded: { size: number; mtime: number } | undefined;
    let warnedLarge = false;

    const reportReadError = (err: unknown): void => {
      const msg = `CSV Viewer: could not read "${basename(uri)}": ${err instanceof Error ? err.message : String(err)}`;
      if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level: "error", message: msg });
      void vscode.window.showErrorMessage(msg);
    };

    const postLoad = async (force: boolean): Promise<void> => {
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch (err) {
        // Watcher-driven failures are usually transient (mid-write, or a delete that onDidDelete handles).
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

    // A single-filename RelativePattern also works for files outside any open workspace folder.
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
    // Atomic saves emit delete then create, so re-check after a grace period before reporting deletion.
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
      stored.pageSize = normalizePageSize(stored.pageSize);
      stored.delimiter = typeof stored.delimiter === "string" ? stored.delimiter : "";
      stored.quotes = typeof stored.quotes === "boolean" ? stored.quotes : true;
      stored.markdownColumns = normalizeColumnFlags(stored.markdownColumns);
      return stored;
    }

    return createDefaultViewState();
  }

  private saveState(fileKey: string, state: ViewState): void {
    void this.context.workspaceState.update(STATE_PREFIX + fileKey, state);
  }

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
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "codicon.css"));
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
<link rel="stylesheet" href="${codiconUri}" />
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
