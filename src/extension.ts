import * as vscode from "vscode";
import { normalizeColumnFlags } from "./core/columns";
import { isRecordEdited, recordFieldsForWrite, spliceBytes } from "./core/csvEdit";
import { serializeRecord } from "./core/csvSerialize";
import { normalizePageSize } from "./core/paging";
import { addByteOffsets, splitRecordsToTable } from "./core/recordSpans";
import { isValidUtf8 } from "./core/utf8";
import {
  createDefaultViewState,
  type EditMessage,
  type HostToWebviewMessage,
  type PendingRecordEdit,
  type RecordFloor,
  type ReadOnlyReason,
  type ViewState,
  type WebviewToHostMessage,
} from "./core/types";

// Reassignable so the test hook can answer the prompt; a real notification can't be clicked in tests.
type ShowPromptFn = (message: string, options: { modal?: boolean }, ...items: string[]) => Thenable<string | undefined>;
let showPrompt: ShowPromptFn = (message, options, ...items) =>
  options.modal ? vscode.window.showWarningMessage(message, { modal: true }, ...items) : vscode.window.showInformationMessage(message, ...items);

const VIEW_TYPE = "csvViewer.table";
const STATE_PREFIX = "csvViewer.state:";
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const HARD_LIMIT_BYTES = 512 * 1024 * 1024;
const RELOAD_DEBOUNCE_MS = 300;
const DELETE_GRACE_MS = 500;
const FLUSH_TIMEOUT_MS = 500;
const REASSERT_DIRTY_FALLBACK_MS = 500;

const SUGGEST_DONE_KEY = "csvViewer.suggestOnOpen.done";
const HINTS_SEEN_KEY = "csvViewer.hintsSeen";

const TEST_HOOKS_ENABLED = process.env.CSV_VIEWER_TEST_HOOKS === "1";
const testHookPanels = new Map<string, vscode.WebviewPanel>();
const testHookDocuments = new Map<string, CsvDocument>();
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
  getDocument(fileKey: string): { dirty: boolean; editCount: number; baseVersion: number; bytesLength: number } | undefined;
  saveDocumentAs(fileKey: string, destination: vscode.Uri): Promise<void>;
  backupDocument(fileKey: string, destination: vscode.Uri): Promise<string>;
  openDocumentFromBackup(uri: vscode.Uri, backupId: string): Promise<{ editCount: number }>;
}

export function activate(context: vscode.ExtensionContext): CsvViewerTestApi | undefined {
  const provider = new CsvEditorProvider(context);

  if (TEST_HOOKS_ENABLED) {
    showPrompt = (message, _options, ...buttons) =>
      new Promise<string | undefined>((resolve) => {
        testHookPendingPrompt = { message, buttons, resolve };
      });
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("csvViewer.editing")) provider.refreshEditable();
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
    vscode.commands.registerCommand("csvViewer.openAsText", () => openAsText(context, CsvEditorProvider.activeDocument)),
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
      getDocument: (fileKey) => {
        const document = testHookDocuments.get(fileKey);
        if (!document) return undefined;
        return { dirty: document.dirty, editCount: document.edited.size, baseVersion: document.baseVersion, bytesLength: document.bytes?.length ?? 0 };
      },
      saveDocumentAs: (fileKey, destination) => {
        const document = testHookDocuments.get(fileKey);
        if (!document) return Promise.reject(new Error(`saveDocumentAs: no document for ${fileKey}`));
        return Promise.resolve(provider.saveCustomDocumentAs(document, destination, new vscode.CancellationTokenSource().token));
      },
      backupDocument: async (fileKey, destination) => {
        const document = testHookDocuments.get(fileKey);
        if (!document) throw new Error(`backupDocument: no document for ${fileKey}`);
        const backup = await provider.backupCustomDocument(document, { destination }, new vscode.CancellationTokenSource().token);
        return backup.id;
      },
      openDocumentFromBackup: async (uri, backupId) => {
        const document = await provider.openCustomDocument(uri, { backupId, untitledDocumentData: undefined }, new vscode.CancellationTokenSource().token);
        const editCount = document.edited.size;
        document.dispose();
        return { editCount };
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
    choice = await showPrompt(`View "${name}" as a table?`, {}, OPEN_AS_TABLE, ALWAYS_FOR_CSV, DONT_ASK_AGAIN);
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

interface RecordState {
  originalText: string;
  originalFields: string[];
  fields: string[];
  // The record's field count when first touched; trailing empties above it are not written.
  floor: number;
  // The file's column count when the record was first touched.
  columns: number;
}

type LoadError = { kind: "read"; error: unknown } | { kind: "tooLarge" };

interface BackupFile {
  version: 1;
  fingerprint: { size: number; mtime: number } | null;
  format: { delimiter: string; quoting: boolean } | null;
  records: {
    recordIndex: number;
    originalText: string;
    originalFields: string[];
    fields: string[];
    floor?: number;
    columns?: number;
  }[];
}

class CsvDocument implements vscode.CustomDocument {
  // The file exactly as last loaded or saved. Save, Save As, backup and revert must work while the webview is hidden or gone.
  bytes: Uint8Array | undefined;
  lastLoaded: { size: number; mtime: number } | undefined;
  baseVersion = 0;
  // Bumped whenever `records` is discarded; an undo entry from an earlier epoch refers to records that no longer exist.
  epoch = 0;
  // The base before the last save, while nothing else has changed the bytes.
  saveBase = -1;
  queue: Promise<void> = Promise.resolve();
  format: { delimiter: string; quoting: boolean } | undefined;
  records = new Map<number, RecordState>();
  edited = new Set<number>();
  loadError: LoadError | undefined;
  largeWarningPending = false;
  largeWarned = false;
  lossy = false;
  restoredFromBackup = false;
  // delimiter, header and quote choices of the webview's last saved state; edits are only meaningful under one tokenization.
  formatKey = "";

  panel: vscode.WebviewPanel | undefined;
  send: ((message: HostToWebviewMessage) => void) | undefined;
  // The base the webview last confirmed it reached (`synced`), not the one we last sent.
  syncedBase = 0;
  webviewReady = false;
  isDeleted = false;
  changedOnDisk = false;
  pendingFlush: { baseVersion: number; resolve: () => void } | undefined;
  // Set after a save that left edits behind: VS Code has just marked the document clean and must be told otherwise.
  reassertDirtyTimer: ReturnType<typeof setTimeout> | undefined;

  reloadDebounceHandle: ReturnType<typeof setTimeout> | undefined;
  deleteCheckHandle: ReturnType<typeof setTimeout> | undefined;
  readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    readonly uri: vscode.Uri,
    private readonly onDispose: (document: CsvDocument) => void,
  ) {}

  get dirty(): boolean {
    return this.edited.size > 0;
  }

  get name(): string {
    return basename(this.uri);
  }

  dispose(): void {
    if (this.reloadDebounceHandle) clearTimeout(this.reloadDebounceHandle);
    if (this.deleteCheckHandle) clearTimeout(this.deleteCheckHandle);
    if (this.reassertDirtyTimer) clearTimeout(this.reassertDirtyTimer);
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions.length = 0;
    this.onDispose(this);
  }
}

// One empty field serializes to an empty line, and blank lines are not records.
function vanishes(fields: string[]): boolean {
  return fields.length === 0 || (fields.length === 1 && fields[0] === "");
}

function notify(level: "warning" | "error", message: string): void {
  if (TEST_HOOKS_ENABLED) testHookNotifications.push({ level, message });
  if (level === "error") void vscode.window.showErrorMessage(message);
  else void vscode.window.showWarningMessage(message);
}

// The same memory as a plain Uint8Array. readFile returns a Node Buffer in the extension host, and VS Code's message serializer runs inside
// JSON.stringify, which calls Buffer.prototype.toJSON first: a Buffer goes out as {"type":"Buffer","data":[...]}, not as a binary attachment.
function plainView(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeText(bytes: Uint8Array): { text: string; lossy: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), lossy: false };
  } catch {
    // A lossy decode cannot be mapped back to bytes, so such a file is read-only.
    return { text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes), lossy: true };
  }
}

class CsvEditorProvider implements vscode.CustomEditorProvider<CsvDocument> {
  static activeDocument: CsvDocument | undefined;

  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CsvDocument> | vscode.CustomDocumentContentChangeEvent<CsvDocument>>();
  // The API types this as the edit-event flavour; content-change events are told apart by lacking undo/redo.
  readonly onDidChangeCustomDocument = this.changeEmitter.event as vscode.Event<vscode.CustomDocumentEditEvent<CsvDocument>>;
  private readonly documents = new Set<CsvDocument>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  refreshEditable(): void {
    for (const document of this.documents) {
      const reason = this.readOnlyReason(document);
      document.send?.({ type: "setEditable", editable: reason === undefined, readOnlyReason: reason });
    }
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, _token: vscode.CancellationToken): Promise<CsvDocument> {
    const document = new CsvDocument(uri, (doc) => {
      this.documents.delete(doc);
      if (CsvEditorProvider.activeDocument === doc) CsvEditorProvider.activeDocument = undefined;
      if (TEST_HOOKS_ENABLED && testHookDocuments.get(doc.uri.toString()) === doc) testHookDocuments.delete(doc.uri.toString());
    });
    this.documents.add(document);
    // The first document per file is the one under test; the scratch ones the backup hook opens must not shadow it.
    if (TEST_HOOKS_ENABLED && !testHookDocuments.has(uri.toString())) testHookDocuments.set(uri.toString(), document);

    // Never throws for an unreadable or oversized file: the first `ready` reports it, as the old stat-then-read load did.
    try {
      await this.loadFromDisk(document, await vscode.workspace.fs.stat(uri));
    } catch (err) {
      document.loadError = { kind: "read", error: err };
    }

    if (openContext.backupId) await this.restoreBackup(document, openContext.backupId);
    this.watch(document);
    return document;
  }

  // Replaces the document's bytes with the file's current contents; false on a read failure or an oversized file.
  private async loadFromDisk(document: CsvDocument, stat: vscode.FileStat): Promise<boolean> {
    if (stat.size > HARD_LIMIT_BYTES) {
      document.loadError = { kind: "tooLarge" };
      return false;
    }
    if (stat.size > LARGE_FILE_BYTES && !document.largeWarned) {
      document.largeWarned = true;
      document.largeWarningPending = true;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(document.uri);
    } catch (err) {
      document.loadError = { kind: "read", error: err };
      return false;
    }
    document.bytes = bytes;
    document.lastLoaded = { size: stat.size, mtime: stat.mtime };
    document.baseVersion++;
    document.loadError = undefined;
    document.changedOnDisk = false;
    this.discardRecords(document);
    return true;
  }

  private discardRecords(document: CsvDocument): void {
    document.records.clear();
    document.edited.clear();
    document.format = undefined;
    document.saveBase = -1;
    document.epoch++;
  }

  private reportLoadFailure(document: CsvDocument): void {
    const error = document.loadError;
    if (!error) return;
    if (error.kind === "tooLarge") {
      notify("error", `CSV Viewer: "${document.name}" is larger than 512 MB and was not loaded.`);
    } else {
      notify("error", `CSV Viewer: could not read "${document.name}": ${error.error instanceof Error ? error.error.message : String(error.error)}`);
    }
  }

  private flushNotices(document: CsvDocument): void {
    if (!document.largeWarningPending) return;
    document.largeWarningPending = false;
    notify("warning", `CSV Viewer: "${document.name}" is larger than 50 MB. Loading it may be slow.`);
  }

  private async restoreBackup(document: CsvDocument, backupId: string): Promise<void> {
    let backup: BackupFile;
    try {
      backup = JSON.parse(new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(backupId))));
    } catch (err) {
      console.warn(`CSV Viewer: could not read the backup of "${document.name}":`, err);
      return;
    }
    if (backup.version !== 1) {
      console.warn(`CSV Viewer: ignoring a backup of "${document.name}" with unknown version ${String(backup.version)}`);
      return;
    }
    const fingerprint = backup.fingerprint;
    const last = document.lastLoaded;
    if (!fingerprint || !last || fingerprint.size !== last.size || fingerprint.mtime !== last.mtime) {
      notify("warning", `CSV Viewer: the unsaved edits to "${document.name}" couldn't be restored because the file changed.`);
      return;
    }
    document.format = backup.format ?? undefined;
    for (const r of backup.records) {
      const record: RecordState = { originalText: r.originalText, originalFields: r.originalFields, fields: r.fields, floor: r.floor ?? r.originalFields.length, columns: r.columns ?? 1 };
      document.records.set(r.recordIndex, record);
      this.updateEditedness(document, r.recordIndex, record);
    }
    document.restoredFromBackup = document.dirty;
  }

  async resolveCustomEditor(document: CsvDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
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
    CsvEditorProvider.activeDocument = document;
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
    document.panel = webviewPanel;
    document.send = send;
    document.syncedBase = 0;
    document.webviewReady = false;

    // VS Code only knows a document opened from a backup is dirty if told, and it can only be told once the editor exists.
    if (document.restoredFromBackup) {
      document.restoredFromBackup = false;
      this.changeEmitter.fire({ document });
    }

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) CsvEditorProvider.activeDocument = document;
      // A saved/load posted while hidden may not have arrived; a full load is always safe.
      if (e.webviewPanel.visible && document.webviewReady && document.bytes && document.syncedBase !== document.baseVersion) this.postLoad(document);
    });

    const handleWebviewMessage = (message: WebviewToHostMessage): void => {
      if (TEST_HOOKS_ENABLED) {
        const arr = testHookMessages.get(fileKey) ?? [];
        arr.push(message);
        testHookMessages.set(fileKey, arr);
      }
      this.onWebviewMessage(document, message);
    };
    const messageSub = webview.onDidReceiveMessage(handleWebviewMessage);
    if (TEST_HOOKS_ENABLED) testHookMessageHandlers.set(fileKey, handleWebviewMessage);

    webviewPanel.onDidDispose(() => {
      viewStateSub.dispose();
      messageSub.dispose();
      if (document.panel === webviewPanel) {
        document.panel = undefined;
        document.send = undefined;
      }
      document.pendingFlush?.resolve();
      // A newer panel for the same file (a moved editor) owns the hooks now.
      if (TEST_HOOKS_ENABLED) {
        if (testHookPanels.get(fileKey) === webviewPanel) testHookPanels.delete(fileKey);
        if (testHookMessageHandlers.get(fileKey) === handleWebviewMessage) testHookMessageHandlers.delete(fileKey);
      }
    });
  }

  private onWebviewMessage(document: CsvDocument, message: WebviewToHostMessage): void {
    switch (message.type) {
      case "ready":
        void this.onReady(document);
        break;
      case "saveState":
        this.onSaveState(document, message.state);
        break;
      case "openAsText":
        void openAsText(this.context, document);
        break;
      case "hintSeen":
        this.markHintSeen(message.id);
        break;
      case "edit":
        this.onEdit(document, message);
        break;
      case "revert":
        document.panel?.reveal(document.panel.viewColumn, false);
        void vscode.commands.executeCommand("workbench.action.files.revert");
        break;
      case "flushed":
        if (document.pendingFlush?.baseVersion === message.baseVersion) document.pendingFlush.resolve();
        break;
      case "synced":
        document.syncedBase = message.baseVersion;
        if (document.reassertDirtyTimer && message.baseVersion === document.baseVersion) this.reassertDirty(document);
        break;
      case "resync":
        this.postLoad(document);
        break;
      case "editsDropped":
        this.onEditsDropped(document, message.recordIndexes);
        break;
    }
  }

  private async onReady(document: CsvDocument): Promise<void> {
    document.webviewReady = true;
    // A clean document may have changed on disk since it was opened (or since the last event we saw).
    if (!document.dirty) await this.syncFromDisk(document);
    if (document.loadError) this.reportLoadFailure(document);
    if (!document.bytes) return;
    this.flushNotices(document);
    this.postLoad(document);
  }

  // The webview writes the separator it detected into an Auto choice on the first edit; the tokenization the edits are addressed in is the same.
  private isPin(document: CsvDocument, state: ViewState): boolean {
    if (!document.format) return false;
    let stored: unknown;
    try {
      stored = JSON.parse(document.formatKey);
    } catch {
      return false;
    }
    if (!Array.isArray(stored)) return false;
    const [delimiter, firstRowIsHeader, quotes] = stored;
    return delimiter === "" && state.delimiter === document.format.delimiter && state.firstRowIsHeader === firstRowIsHeader && state.quotes === quotes;
  }

  private onSaveState(document: CsvDocument, state: ViewState): void {
    const fileKey = document.uri.toString();
    const formatKey = JSON.stringify([state.delimiter, state.firstRowIsHeader, state.quotes]);
    const changed = document.formatKey !== "" && formatKey !== document.formatKey && !this.isPin(document, state);
    if (changed && document.dirty) {
      // Edits are addressed by record and field index under one tokenization; keep the stored format and put the webview back on it.
      const stored = this.loadOrCreateState(fileKey);
      this.saveState(fileKey, { ...state, delimiter: stored.delimiter, firstRowIsHeader: stored.firstRowIsHeader, quotes: stored.quotes });
      this.postLoad(document);
      return;
    }
    this.saveState(fileKey, state);
    // A changed format makes the records (and any undo entries) meaningless.
    if (changed) this.discardRecords(document);
    document.formatKey = formatKey;
  }

  private readOnlyReason(document: CsvDocument): ReadOnlyReason | undefined {
    if (!vscode.workspace.getConfiguration("csvViewer").get<boolean>("editing", true)) return "setting";
    if (document.lossy) return "encoding";
    if (vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false) return "filesystem";
    return undefined;
  }

  private postLoad(document: CsvDocument): void {
    if (!document.send || !document.bytes) return;
    const fileKey = document.uri.toString();
    document.lossy = !isValidUtf8(document.bytes);
    const reason = this.readOnlyReason(document);
    const state = this.loadOrCreateState(fileKey);
    document.formatKey = JSON.stringify([state.delimiter, state.firstRowIsHeader, state.quotes]);

    const pendingEdits: PendingRecordEdit[] = [];
    for (const recordIndex of [...document.edited].sort((a, b) => a - b)) {
      const record = document.records.get(recordIndex)!;
      pendingEdits.push({
        recordIndex,
        originalFields: record.originalFields,
        fields: this.fieldsToWrite(record),
      });
    }

    // Only records whose floor is below their field count differ from what the webview derives for itself.
    const recordFloors: RecordFloor[] = [];
    for (const [recordIndex, record] of document.records) {
      if (record.floor < record.originalFields.length) recordFloors.push({ recordIndex, floor: record.floor });
    }

    document.send({
      type: "load",
      fileKey,
      bytes: plainView(document.bytes),
      state,
      defaultTableColumns: this.defaultTableColumns(),
      defaultDelimiter: this.delimiterFor(document.uri) ?? "",
      hintsSeen: this.context.globalState.get<string[]>(HINTS_SEEN_KEY, []),
      testHooks: TEST_HOOKS_ENABLED,
      baseVersion: document.baseVersion,
      editable: reason === undefined,
      readOnlyReason: reason,
      pendingEdits,
      recordFloors,
    });

    if (document.isDeleted) document.send({ type: "fileDeleted", name: document.name });
    if (document.changedOnDisk) document.send({ type: "fileChangedOnDisk", name: document.name });
  }

  // Re-reads a clean document when the file differs from what it holds; true if the bytes were replaced.
  private async syncFromDisk(document: CsvDocument): Promise<boolean> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(document.uri);
    } catch (err) {
      // Usually transient (mid-write, or a delete the delete handler deals with); only a document that never loaded cares.
      if (!document.bytes) document.loadError = { kind: "read", error: err };
      return false;
    }
    const last = document.lastLoaded;
    if (document.bytes && last && last.size === stat.size && last.mtime === stat.mtime) return false;
    return this.loadFromDisk(document, stat);
  }

  private watch(document: CsvDocument): void {
    // A single-filename RelativePattern also works for files outside any open workspace folder.
    const uri = document.uri;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), basename(uri)));

    const scheduleReload = (): void => {
      if (document.reloadDebounceHandle) clearTimeout(document.reloadDebounceHandle);
      document.reloadDebounceHandle = setTimeout(() => {
        document.reloadDebounceHandle = undefined;
        void this.onDiskChanged(document);
      }, RELOAD_DEBOUNCE_MS);
    };

    document.subscriptions.push(
      watcher,
      watcher.onDidChange(scheduleReload),
      watcher.onDidCreate(scheduleReload),
      // Atomic saves emit delete then create, so re-check after a grace period before reporting deletion.
      watcher.onDidDelete(() => {
        if (document.reloadDebounceHandle) {
          clearTimeout(document.reloadDebounceHandle);
          document.reloadDebounceHandle = undefined;
        }
        if (document.deleteCheckHandle) clearTimeout(document.deleteCheckHandle);
        document.deleteCheckHandle = setTimeout(async () => {
          document.deleteCheckHandle = undefined;
          try {
            await vscode.workspace.fs.stat(uri);
            scheduleReload();
          } catch {
            const kept = document.dirty ? " Your unsaved edits are kept; saving will recreate it." : " Showing the last loaded contents.";
            notify("warning", `CSV Viewer: "${document.name}" was deleted.${kept}`);
            document.isDeleted = true;
            document.send?.({ type: "fileDeleted", name: document.name });
          }
        }, DELETE_GRACE_MS);
      }),
    );
  }

  private async onDiskChanged(document: CsvDocument): Promise<void> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(document.uri);
    } catch {
      return;
    }
    const wasDeleted = document.isDeleted;
    document.isDeleted = false;
    const last = document.lastLoaded;
    const differs = !document.bytes || !last || last.size !== stat.size || last.mtime !== stat.mtime;

    if (document.dirty) {
      // Reloading would throw the edits away; say so and let the user choose between reverting and saving over it.
      if (differs && !document.changedOnDisk) {
        document.changedOnDisk = true;
        document.send?.({ type: "fileChangedOnDisk", name: document.name });
      }
    } else if (differs && (await this.loadFromDisk(document, stat))) {
      this.flushNotices(document);
      this.postLoad(document);
    }
    if (wasDeleted) document.send?.({ type: "fileRestored" });
  }

  private updateEditedness(document: CsvDocument, recordIndex: number, record: RecordState): void {
    if (isRecordEdited(record.originalFields, record.fields, record.floor, record.columns)) document.edited.add(recordIndex);
    else document.edited.delete(recordIndex);
  }

  private fieldsToWrite(record: RecordState): string[] {
    return recordFieldsForWrite(record.originalFields, record.fields, record.floor, record.columns);
  }

  private onEdit(document: CsvDocument, message: EditMessage): void {
    // An edit committed against the base just before the save was made before the webview saw `saved`. The save rewrote only the records it
    // wrote, so such an edit is accepted for any other record (it is checked against the held record below). For a record the save did
    // write, the webview's baseline is the pre-save one, so the text is not compared and the host keeps its own record.
    const justSaved = document.saveBase === message.baseVersion && document.baseVersion === message.baseVersion + 1;
    if (document.lossy || (message.baseVersion !== document.baseVersion && !justSaved)) {
      this.postLoad(document);
      return;
    }
    const change = message.change;
    const info = change.record;
    if (document.format && (document.format.delimiter !== change.format.delimiter || document.format.quoting !== change.format.quoting)) {
      this.postLoad(document);
      return;
    }
    let record = document.records.get(change.recordIndex);
    if (record && !justSaved && record.originalText !== info.originalText) {
      console.error(`csv-viewer: dropped an edit to record ${change.recordIndex} of "${document.name}": its text disagrees with the one on record`);
      this.postLoad(document);
      return;
    }
    if (!record) {
      record = {
        originalText: info.originalText,
        originalFields: info.originalFields.slice(),
        fields: info.originalFields.slice(),
        floor: info.originalFields.length,
        columns: info.columns,
      };
    }
    // A record that would be written as one empty field is an empty line, which reads back as no record at all.
    const prospective = record.fields.slice();
    while (prospective.length <= change.columnIndex) prospective.push("");
    prospective[change.columnIndex] = change.newValue;
    if (vanishes(recordFieldsForWrite(record.originalFields, prospective, record.floor, record.columns)) && isRecordEdited(record.originalFields, prospective, record.floor, record.columns)) {
      console.error(`csv-viewer: refused an edit that would empty record ${change.recordIndex} of "${document.name}"`);
      this.postLoad(document);
      document.send?.({ type: "editRefused", message: "that edit would leave the row empty, which removes it from the file" });
      return;
    }
    document.records.set(change.recordIndex, record);
    document.format ??= change.format;

    const apply = record;
    const before = apply.fields[change.columnIndex] ?? "";
    this.setField(document, change.recordIndex, apply, change.columnIndex, change.newValue);

    const epoch = document.epoch;
    const step = (value: string, kind: "undo" | "redo") => (): void => {
      if (epoch !== document.epoch) return;
      const current = document.records.get(change.recordIndex);
      if (!current) return;
      this.setField(document, change.recordIndex, current, change.columnIndex, value);
      document.send?.({
        type: "applyEdits",
        baseVersion: document.baseVersion,
        kind,
        cells: [{ rowId: change.rowId, columnIndex: change.columnIndex, value, original: current.originalFields[change.columnIndex] ?? "" }],
      });
    };

    this.changeEmitter.fire({
      document,
      label: `Edit ${change.column}`,
      undo: step(before, "undo"),
      redo: step(change.newValue, "redo"),
    });
  }

  private setField(document: CsvDocument, recordIndex: number, record: RecordState, columnIndex: number, value: string): void {
    while (record.fields.length <= columnIndex) record.fields.push("");
    record.fields[columnIndex] = value;
    this.updateEditedness(document, recordIndex, record);
  }

  private onEditsDropped(document: CsvDocument, recordIndexes: number[]): void {
    for (const recordIndex of recordIndexes) {
      document.records.delete(recordIndex);
      document.edited.delete(recordIndex);
    }
    if (recordIndexes.length > 0) {
      const named = recordIndexes.map((i) => i + 1).join(", ");
      notify("warning", `CSV Viewer: some unsaved edits to "${document.name}" couldn't be restored because their rows no longer match the file (record numbers ${named}).`);
    }
  }

  // The webview commits any open editor and answers after posting its edits; messages on one channel arrive in order.
  private async flush(document: CsvDocument): Promise<void> {
    if (!document.send || !document.panel) return;
    const baseVersion = document.baseVersion;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        document.pendingFlush = { baseVersion, resolve };
        document.send!({ type: "flushEdits", baseVersion });
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    document.pendingFlush = undefined;
  }

  // Saves, Save As and reverts of one document never overlap: each reads state the others rewrite.
  private exclusive<T>(document: CsvDocument, task: () => Promise<T>): Promise<T> {
    const run = document.queue.then(task, task);
    document.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // The file's bytes with every edited record rewritten. Record boundaries come from splitting the held bytes here, never from the webview's offsets;
  // throws, writing nothing, if a record's text is not what the edit was made against.
  private buildOutput(document: CsvDocument): { out: Uint8Array; written: { recordIndex: number; fields: string[]; text: string }[] } {
    const bytes = document.bytes;
    if (!bytes) throw new Error(`CSV Viewer: "${document.name}" was never loaded`);
    const edited = [...document.edited].sort((a, b) => a - b);
    if (edited.length === 0) return { out: bytes, written: [] };

    const format = document.format;
    const consistency = new Error("CSV Viewer: internal consistency check failed; nothing was written");
    if (!format) throw consistency;
    const decoded = decodeText(bytes);
    if (decoded.lossy) throw consistency;
    const table = splitRecordsToTable(decoded.text, { delimiter: format.delimiter, quotes: format.quoting });
    addByteOffsets(table, decoded.text, bytes.length);

    const written: { recordIndex: number; fields: string[]; text: string }[] = [];
    for (const recordIndex of edited) {
      const record = document.records.get(recordIndex)!;
      if (recordIndex >= table.length || decoded.text.slice(table.start[recordIndex], table.end[recordIndex]) !== record.originalText) throw consistency;
      const fields = this.fieldsToWrite(record);
      if (vanishes(fields)) throw consistency;
      written.push({ recordIndex, fields, text: serializeRecord(fields, format.delimiter, format.quoting) });
    }
    try {
      const out = spliceBytes(
        bytes,
        written.map((w) => ({ byteStart: table.byteStart![w.recordIndex], byteEnd: table.byteEnd![w.recordIndex], fields: w.fields })),
        format.delimiter,
        format.quoting,
      );
      return { out, written };
    } catch {
      throw consistency;
    }
  }

  saveCustomDocument(document: CsvDocument, token: vscode.CancellationToken): Thenable<void> {
    return this.exclusive(document, async () => {
      await this.flush(document);
      // Also what neutralizes a stale undo entry that toggled VS Code's dirty flag without changing anything.
      if (!document.dirty) return;
      if (token.isCancellationRequested) throw new Error("Save cancelled");

      await this.confirmOverwriteIfChanged(document);
      const { out, written } = this.buildOutput(document);

      try {
        await vscode.workspace.fs.writeFile(document.uri, out);
      } catch (err) {
        throw new Error(`CSV Viewer: could not save "${document.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const stat = await vscode.workspace.fs.stat(document.uri);
        document.lastLoaded = { size: stat.size, mtime: stat.mtime };
      } catch {
        document.lastLoaded = undefined;
      }

      // Edits and undos that arrived during the write live on the records; only what was written becomes the baseline.
      for (const w of written) {
        const record = document.records.get(w.recordIndex);
        if (!record) continue;
        record.originalText = w.text;
        record.originalFields = w.fields.slice();
      }
      document.edited.clear();
      for (const [recordIndex, record] of document.records) this.updateEditedness(document, recordIndex, record);
      document.bytes = out;
      document.changedOnDisk = false;
      document.saveBase = document.baseVersion;
      document.baseVersion++;
      // VS Code marks the document clean when this returns; edits made during the write still need saving. The event goes out once the
      // webview confirms the new base (which can only happen after the save reply has left), or after a delay if the webview is hidden.
      if (document.dirty) {
        if (document.reassertDirtyTimer) clearTimeout(document.reassertDirtyTimer);
        document.reassertDirtyTimer = setTimeout(() => this.reassertDirty(document), REASSERT_DIRTY_FALLBACK_MS);
      }
      document.send?.({
        type: "saved",
        baseVersion: document.baseVersion,
        written: written.map((w) => ({ recordIndex: w.recordIndex, fields: w.fields, floor: document.records.get(w.recordIndex)?.floor ?? w.fields.length })),
      });
    });
  }

  // A content-change event without an undo entry, so the undo stack is untouched.
  private reassertDirty(document: CsvDocument): void {
    if (document.reassertDirtyTimer) clearTimeout(document.reassertDirtyTimer);
    document.reassertDirtyTimer = undefined;
    if (document.dirty) this.changeEmitter.fire({ document });
  }

  private async confirmOverwriteIfChanged(document: CsvDocument): Promise<void> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(document.uri);
    } catch {
      return; // a missing file is not a conflict: saving recreates it
    }
    const last = document.lastLoaded;
    if (!last || (last.size === stat.size && last.mtime === stat.mtime)) return;
    const OVERWRITE = "Overwrite";
    const choice = await showPrompt(`"${document.name}" has changed on disk since you opened it. Overwrite it with your edits?`, { modal: true }, OVERWRITE);
    if (choice !== OVERWRITE) throw new Error("Save cancelled: the file changed on disk");
  }

  saveCustomDocumentAs(document: CsvDocument, destination: vscode.Uri, _token: vscode.CancellationToken): Thenable<void> {
    return this.exclusive(document, async () => {
      await this.flush(document);
      const { out } = this.buildOutput(document);
      try {
        await vscode.workspace.fs.writeFile(destination, out);
      } catch (err) {
        throw new Error(`CSV Viewer: could not save "${basename(destination)}": ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  revertCustomDocument(document: CsvDocument, _token: vscode.CancellationToken): Thenable<void> {
    return this.exclusive(document, async () => {
      this.discardRecords(document);
      try {
        const stat = await vscode.workspace.fs.stat(document.uri);
        // loadFromDisk bumps baseVersion itself; the held bytes stay if the file is gone or unreadable.
        if (!(await this.loadFromDisk(document, stat))) document.baseVersion++;
      } catch {
        document.baseVersion++;
      }
      document.changedOnDisk = false;
      this.postLoad(document);
    });
  }

  async backupCustomDocument(document: CsvDocument, context: vscode.CustomDocumentBackupContext, _token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    const backup: BackupFile = {
      version: 1,
      fingerprint: document.lastLoaded ?? null,
      format: document.format ?? null,
      records: [...document.edited]
        .sort((a, b) => a - b)
        .map((recordIndex) => {
          const r = document.records.get(recordIndex)!;
          return { recordIndex, originalText: r.originalText, originalFields: r.originalFields, fields: this.fieldsToWrite(r), floor: r.floor, columns: r.columns };
        }),
    };
    const destination = context.destination;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, ".."));
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(JSON.stringify(backup)));
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // already gone
        }
      },
    };
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

async function openAsText(context: vscode.ExtensionContext, document: CsvDocument | undefined): Promise<void> {
  if (!document) return;
  // Replacing a dirty custom editor's tab is not something this extension could verify keeps the edits, so refuse rather than risk losing them.
  if (document.dirty) {
    notify("warning", "Save or revert your edits before opening as text.");
    return;
  }

  // Using "Open as Text" shows the user knows the viewer exists, so stop suggesting it.
  void context.globalState.update(SUGGEST_DONE_KEY, true);
  await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
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
