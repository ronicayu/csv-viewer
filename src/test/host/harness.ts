import { applyTextPatches } from "../../core/csvEdit";
import type { HostToWebviewMessage, PendingRecordEdit, WebviewToHostMessage } from "../../core/types";
import * as fake from "./fakeVscode";

// Must be set before extension.ts is first imported.
process.env.CSV_VIEWER_TEST_HOOKS = "1";

type WorkerRequest = { type: string; [key: string]: unknown };
type WorkerResponse = { type: string; [key: string]: any };

let workerHandler: ((event: { data: WorkerRequest }) => void) | undefined;
let workerOut: WorkerResponse[] = [];
let requestId = 0;
let booted: Promise<void> | undefined;

export interface TestApi {
  getDocument(fileKey: string): { dirty: boolean; editCount: number; baseVersion: number; bytesLength: number } | undefined;
  saveDocumentAs(fileKey: string, destination: fake.Uri): Promise<void>;
  backupDocument(fileKey: string, destination: fake.Uri): Promise<string>;
  openDocumentFromBackup(uri: fake.Uri, backupId: string): Promise<{ editCount: number }>;
  getPendingPrompt(): { message: string; buttons: string[] } | undefined;
  choosePromptButton(button: string | undefined): void;
}

export interface Host {
  api: TestApi;
  provider: any;
}

function memento() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
    keys: () => [...values.keys()],
  };
}

let host: Host | undefined;

// Loads the real worker and the real extension against the fake vscode module.
export async function bootHost(): Promise<Host> {
  booted ??= (async () => {
    (globalThis as any).self = {
      addEventListener: (_type: string, fn: typeof workerHandler) => {
        workerHandler = fn;
      },
      postMessage: (m: WorkerResponse) => workerOut.push(m),
    };
    await import("../../webview/worker");
    const extension = await import("../../extension");
    const api = extension.activate({
      subscriptions: [],
      globalState: memento(),
      workspaceState: memento(),
      extensionUri: fake.Uri.file("/ext"),
    } as any) as unknown as TestApi;
    host = { api, provider: fake.world.provider };
  })();
  await booted;
  return host!;
}

// Everything the worker has posted so far, including what its own timers and channels sent between calls.
export function workerMessages(): WorkerResponse[] {
  return workerOut;
}

export function callWorker(request: WorkerRequest): WorkerResponse[] {
  const before = workerOut.length;
  workerHandler!({ data: { requestId: ++requestId, ...request } });
  return workerOut.slice(before);
}

export function workerReply(request: WorkerRequest, type: string): WorkerResponse {
  return callWorker(request).find((m) => m.type === type)!;
}

// The string the webview makes of a load message, decoding its bytes as the webview does.
export function loadText(message: { text?: string; bytes?: ArrayBuffer }): string {
  return message.text ?? new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(message.bytes!));
}

export const token = new fake.CancellationTokenSource().token;

export interface OpenOptions {
  // What the webview's view state says; "" means auto-detect.
  delimiter?: string;
  firstRowIsHeader?: boolean;
  quotes?: boolean;
  backupId?: string;
  // Opens the file as it already is in the fake file system.
  existing?: boolean;
  // Opens the file but leaves the webview unready until `ready()` is called.
  deferReady?: boolean;
}

// A stand-in for the webview's main thread: real worker, real messages, no DOM.
export class Session {
  readonly messages: HostToWebviewMessage[] = [];
  readonly received: WebviewToHostMessage[] = [];
  readonly stack: { undo(): void; redo(): void; label?: string }[] = [];
  pointer = 0;
  baseVersion = 0;
  text = "";
  rows: string[][] = [];
  headers: string[] = [];
  dropped: number[] = [];
  // Content-change events with no undo entry: how the host tells VS Code the document is dirty again.
  contentChanges = 0;
  // Set false to model a webview that never answers `saved` (hidden, or busy).
  autoSync = true;
  private recordFloors = new Map<number, number>();
  private deliver: (m: WebviewToHostMessage) => void = () => {};
  private viewState: (e: unknown) => void = () => {};
  private disposePanel: () => void = () => {};
  private options = { delimiter: undefined as string | undefined, firstRowIsHeader: true, quotes: true };
  private subscription: { dispose(): void } | undefined;

  constructor(
    readonly host: Host,
    readonly doc: any,
    readonly path: string,
  ) {}

  get key(): string {
    return this.doc.uri.toString();
  }

  get dirty(): boolean {
    return this.doc.dirty;
  }

  file(): string {
    return fake.readFileText(this.path);
  }

  of(type: string): any[] {
    return this.messages.filter((m) => m.type === type);
  }

  async attach(options: OpenOptions): Promise<void> {
    this.subscription = this.host.provider.onDidChangeCustomDocument((e: any) => {
      if (e.document !== this.doc) return;
      if (!e.undo) {
        this.contentChanges++;
        return;
      }
      this.stack.length = this.pointer;
      this.stack.push(e);
      this.pointer++;
    });
    const panel: any = {
      webview: {
        options: {},
        html: "",
        cspSource: "csp",
        asWebviewUri: (u: unknown) => u,
        postMessage: async (m: HostToWebviewMessage) => {
          this.messages.push(m);
          this.onHostMessage(m);
          return true;
        },
        onDidReceiveMessage: (fn: (m: WebviewToHostMessage) => void) => {
          this.deliver = fn;
          return { dispose() {} };
        },
      },
      onDidChangeViewState: (fn: (e: unknown) => void) => {
        this.viewState = fn;
        return { dispose() {} };
      },
      onDidDispose: (fn: () => void) => {
        this.disposePanel = fn;
        return { dispose() {} };
      },
      active: true,
      visible: true,
      viewColumn: 1,
      reveal() {},
    };
    await this.host.provider.resolveCustomEditor(this.doc, panel, token);
    this.options = {
      delimiter: options.delimiter || undefined,
      firstRowIsHeader: options.firstRowIsHeader ?? true,
      quotes: options.quotes ?? true,
    };
  }

  // The webview announces itself; resolves once the host has answered with a load.
  async ready(): Promise<void> {
    this.send({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  send(message: WebviewToHostMessage): void {
    this.received.push(message);
    this.deliver(message);
  }

  changeViewState(visible: boolean, active = true): void {
    this.viewState({ webviewPanel: { visible, active } });
  }

  closePanel(): void {
    this.disposePanel();
  }

  dispose(): void {
    this.subscription?.dispose();
    this.doc.dispose();
  }

  private init(text: string, byteLength: number | undefined, options: { delimiter?: string; firstRowIsHeader: boolean; quotes: boolean }): WorkerResponse {
    this.text = text;
    const floors = [...this.recordFloors].map(([recordIndex, floor]) => ({ recordIndex, floor }));
    return workerReply({ type: "init", text, byteLength, options, floors }, "initResult");
  }

  private onHostMessage(m: HostToWebviewMessage): void {
    switch (m.type) {
      case "load": {
        this.baseVersion = m.baseVersion;
        const delimiter = m.state.delimiter || m.defaultDelimiter || this.options.delimiter || undefined;
        this.options = { delimiter, firstRowIsHeader: m.state.firstRowIsHeader, quotes: m.state.quotes };
        this.recordFloors = new Map((m.recordFloors ?? []).map((f) => [f.recordIndex, f.floor]));
        const init = this.init(loadText(m), m.bytes?.byteLength, this.options);
        this.headers = init.headers;
        this.restore(m.pendingEdits);
        this.send({ type: "synced", baseVersion: m.baseVersion });
        break;
      }
      case "saved":
        this.baseVersion = m.baseVersion;
        for (const record of m.written ?? []) this.recordFloors.set(record.recordIndex, record.floor ?? record.fields.length);
        {
          const rebased = workerReply({ type: "rebase", written: m.written }, "rebased");
          this.text = applyTextPatches(this.text, rebased.patches);
        }
        // The real webview answers after a round trip through its worker, i.e. after the host's save has returned.
        if (this.autoSync) setTimeout(() => this.send({ type: "synced", baseVersion: m.baseVersion }), 0);
        break;
      case "applyEdits":
        if (m.baseVersion === this.baseVersion) {
          callWorker({ type: "setCells", cells: m.cells.map(({ rowId, columnIndex, value }) => ({ rowId, columnIndex, value })) });
        }
        break;
      case "flushEdits":
        queueMicrotask(() => this.send({ type: "flushed", baseVersion: m.baseVersion }));
        break;
    }
  }

  private restore(pending: PendingRecordEdit[]): void {
    if (pending.length === 0) return;
    const offset = this.options.firstRowIsHeader ? 1 : 0;
    const cells: { rowId: number; columnIndex: number; value: string }[] = [];
    const verify: { rowId: number; originalFields: string[] }[] = [];
    for (const edit of pending) {
      const rowId = edit.recordIndex - offset;
      verify.push({ rowId, originalFields: edit.originalFields });
      for (let c = 0; c < Math.max(edit.fields.length, edit.originalFields.length); c++) {
        if ((edit.fields[c] ?? "") !== (edit.originalFields[c] ?? "")) cells.push({ rowId, columnIndex: c, value: edit.fields[c] ?? "" });
      }
    }
    const done = workerReply({ type: "setCells", cells, verify }, "setCellsDone");
    const rejected = new Set<number>(done.rejectedRowIds);
    const recordIndexes = pending.filter((e) => rejected.has(e.recordIndex - offset)).map((e) => e.recordIndex);
    if (recordIndexes.length > 0) {
      this.dropped.push(...recordIndexes);
      this.send({ type: "editsDropped", recordIndexes });
    }
  }

  // The webview's commit path: the worker checks and applies the edit, then the host is told.
  tryEdit(rowId: number, columnIndex: number, value: string, baseVersion = this.baseVersion): WorkerResponse {
    const result = workerReply({ type: "editCell", rowId, columnIndex, value }, "editResult");
    if (result.ok && result.change) this.send({ type: "edit", baseVersion, change: result.change });
    return result;
  }

  edit(rowId: number, columnIndex: number, value: string, baseVersion = this.baseVersion): any {
    const result = this.tryEdit(rowId, columnIndex, value, baseVersion);
    if (!result.ok) throw new Error(`edit rejected: ${result.reason}`);
    return result.change;
  }

  undo(): void {
    if (this.pointer === 0) throw new Error("nothing to undo");
    this.stack[--this.pointer].undo();
  }

  redo(): void {
    if (this.pointer >= this.stack.length) throw new Error("nothing to redo");
    this.stack[this.pointer++].redo();
  }

  save(): Thenable<void> {
    return this.host.provider.saveCustomDocument(this.doc, token);
  }

  revert(): Thenable<void> {
    return this.host.provider.revertCustomDocument(this.doc, token);
  }
}

export async function openSession(path: string, content: string | Uint8Array, options: OpenOptions = {}): Promise<Session> {
  const host = await bootHost();
  if (!options.existing) fake.putFile(path, content);
  const doc = await host.provider.openCustomDocument(fake.Uri.file(path), { backupId: options.backupId }, token);
  const session = new Session(host, doc, path);
  await session.attach(options);
  if (!options.deferReady) await session.ready();
  return session;
}

export function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
