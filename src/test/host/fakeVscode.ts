// A small in-memory stand-in for the parts of the vscode API that extension.ts uses, so the provider can run under vitest.
import * as path from "path";

export class Uri {
  constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}

  static file(p: string): Uri {
    return new Uri("file", p);
  }

  static parse(s: string): Uri {
    const match = /^([a-z]+):\/\/(.*)$/.exec(s)!;
    return new Uri(match[1], decodeURIComponent(match[2]));
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, path.posix.join(base.path, ...segments));
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${encodeURI(this.path)}`;
  }
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };

  fire(e: T): void {
    for (const listener of [...this.listeners]) listener(e);
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class RelativePattern {
  constructor(
    readonly base: Uri,
    readonly pattern: string,
  ) {}
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

export class TabInputText {
  constructor(readonly uri: Uri) {}
}

export class TabInputCustom {
  constructor(
    readonly uri: Uri,
    readonly viewType: string,
  ) {}
}

export const ConfigurationTarget = { Global: 1 };
export const ViewColumn = { One: 1, Two: 2 };

export interface FakeWatcher {
  change: EventEmitter<Uri>;
  create: EventEmitter<Uri>;
  del: EventEmitter<Uri>;
  disposed: boolean;
}

export const world = {
  files: new Map<string, { data: Uint8Array; mtime: number }>(),
  clock: 1000,
  notifications: [] as { level: string; message: string; modal?: boolean }[],
  commands: [] as { id: string; args: unknown[] }[],
  registered: {} as Record<string, (...args: any[]) => any>,
  provider: undefined as any,
  config: new Map<string, unknown>(),
  watchers: [] as FakeWatcher[],
  configListeners: [] as ((e: { affectsConfiguration(section: string): boolean }) => void)[],
  // Runs inside writeFile before the bytes land, to play things that happen during a slow write.
  beforeWrite: undefined as undefined | (() => Promise<void> | void),
  writable: true,
};

export function putFile(p: string, data: string | Uint8Array): void {
  world.files.set(p, { data: typeof data === "string" ? new TextEncoder().encode(data) : data, mtime: ++world.clock });
}

export function readFileText(p: string): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(world.files.get(p)!.data);
}

function notFound(p: string): Error {
  return new Error(`ENOENT: ${p}`);
}

export const workspace = {
  fs: {
    async stat(u: Uri) {
      const f = world.files.get(u.path);
      if (!f) throw notFound(u.path);
      return { size: f.data.length, mtime: f.mtime, ctime: 0, type: 1 };
    },
    async readFile(u: Uri) {
      const f = world.files.get(u.path);
      if (!f) throw notFound(u.path);
      // A view into a larger buffer, as a real readFile can return; every consumer must honour byteOffset.
      const backing = new Uint8Array(f.data.length + 25);
      backing.set(f.data, 9);
      return backing.subarray(9, 9 + f.data.length);
    },
    async writeFile(u: Uri, data: Uint8Array) {
      if (world.beforeWrite) {
        const hook = world.beforeWrite;
        world.beforeWrite = undefined;
        await hook();
      }
      world.files.set(u.path, { data: data.slice(), mtime: ++world.clock });
    },
    async createDirectory() {},
    async delete(u: Uri) {
      world.files.delete(u.path);
    },
    isWritableFileSystem: () => world.writable,
  },
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, fallback?: T): T => (world.config.has(`${section}.${key}`) ? (world.config.get(`${section}.${key}`) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => {
      world.config.set(`${section}.${key}`, value);
      for (const listener of world.configListeners) listener({ affectsConfiguration: (s) => s === `${section}.${key}` || s === section });
    },
  }),
  onDidChangeConfiguration: (listener: (e: any) => void) => {
    world.configListeners.push(listener);
    return { dispose() {} };
  },
  onDidRenameFiles: () => ({ dispose() {} }),
  createFileSystemWatcher: () => {
    const change = new EventEmitter<Uri>();
    const create = new EventEmitter<Uri>();
    const del = new EventEmitter<Uri>();
    const watcher: FakeWatcher & Record<string, unknown> = {
      change,
      create,
      del,
      disposed: false,
      onDidChange: change.event,
      onDidCreate: create.event,
      onDidDelete: del.event,
      dispose() {
        watcher.disposed = true;
      },
    };
    world.watchers.push(watcher);
    return watcher;
  },
};

function notifier(level: string) {
  return async (message: string, ...rest: unknown[]) => {
    const options = rest[0] as { modal?: boolean } | undefined;
    world.notifications.push({ level, message, modal: typeof options === "object" && options !== null ? options.modal : undefined });
    return undefined;
  };
}

export const window = {
  showWarningMessage: notifier("warning"),
  showErrorMessage: notifier("error"),
  showInformationMessage: notifier("info"),
  registerCustomEditorProvider: (_viewType: string, provider: unknown) => {
    world.provider = provider;
    return { dispose() {} };
  },
  onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  activeTextEditor: undefined,
  tabGroups: { all: [], activeTabGroup: { activeTab: undefined } },
};

export const commands = {
  registerCommand: (id: string, fn: (...args: any[]) => any) => {
    world.registered[id] = fn;
    return { dispose() {} };
  },
  executeCommand: async (id: string, ...args: unknown[]) => {
    world.commands.push({ id, args });
  },
};
