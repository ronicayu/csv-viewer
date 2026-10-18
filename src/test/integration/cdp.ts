import * as http from "http";

// VS Code drops key events a webview forwards unless they are trusted, and a page script cannot make a trusted one.
// The test VS Code is launched with a debugging port (runTest.ts), and this speaks the protocol to it directly:
// find the frame that holds an element, focus the element there, and send real key events (Input.dispatchKeyEvent).
export const CDP_PORT_ENV = "CSV_VIEWER_CDP_PORT";

export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  // CDP modifier bits: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.
  modifiers: number;
}

export const UNDO_KEY: KeySpec = { key: "z", code: "KeyZ", keyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 };
export const ESCAPE_KEY: KeySpec = { key: "Escape", code: "Escape", keyCode: 27, modifiers: 0 };

// Where an element was found: the debugging session of the target that owns the frame, and a script context in that frame.
export interface Located {
  sessionId: string;
  targetId: string;
  frameId: string;
  contextId: number;
  description: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

interface FrameInfo {
  id: string;
  parentId?: string;
  url: string;
}

const SCANNED_TARGET_TYPES = new Set(["page", "iframe", "webview", "other"]);
const CALL_TIMEOUT_MS = 10000;

function short(text: string, max = 150): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function getText(port: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: Number(port), path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.setTimeout(CALL_TIMEOUT_MS, () => req.destroy(new Error(`GET ${path} timed out`)));
    req.on("error", reject);
  });
}

class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>();

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
      else call.resolve(message.result);
    };
    socket.onclose = () => {
      for (const call of this.pending.values()) call.reject(new Error(`${call.method}: the debugging connection closed`));
      this.pending.clear();
    };
  }

  static open(url: string): Promise<Connection> {
    if (typeof WebSocket === "undefined") throw new Error("this extension host has no global WebSocket");
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(new Connection(socket));
      socket.onerror = () => reject(new Error(`could not open the debugging websocket ${url}`));
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

const RECORDER = `(() => {
  if (!window.__csvKeys) {
    window.__csvKeys = [];
    window.addEventListener("keydown", (e) => window.__csvKeys.push(e.key + (e.ctrlKey ? "+ctrl" : "") + (e.metaKey ? "+meta" : "") + (e.isTrusted ? "" : " untrusted")), true);
  }
  return window.__csvKeys.length;
})()`;

export class WorkbenchDriver {
  private readonly sessions = new Map<string, string>();
  private readonly worlds = new Map<string, number>();

  private constructor(
    private readonly port: string,
    private readonly connection: Connection,
  ) {}

  static async connect(): Promise<WorkbenchDriver> {
    const port = process.env[CDP_PORT_ENV];
    if (!port) throw new Error(`${CDP_PORT_ENV} is not set: the test VS Code was not launched with a debugging port`);
    const version = JSON.parse(await getText(port, "/json/version")) as { webSocketDebuggerUrl: string };
    return new WorkbenchDriver(port, await Connection.open(version.webSocketDebuggerUrl));
  }

  close(): void {
    this.connection.close();
  }

  private async targets(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.connection.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    return targetInfos;
  }

  private async attach(targetId: string): Promise<string> {
    let sessionId = this.sessions.get(targetId);
    if (sessionId) return sessionId;
    ({ sessionId } = await this.connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    this.sessions.set(targetId, sessionId);
    // A window the OS has not focused would otherwise hold back the focus a webview waits for.
    await this.connection.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => undefined);
    return sessionId;
  }

  private async frames(sessionId: string): Promise<FrameInfo[]> {
    const { frameTree } = await this.connection.send<{ frameTree: any }>("Page.getFrameTree", {}, sessionId);
    const out: FrameInfo[] = [];
    const walk = (node: any, parentId?: string): void => {
      out.push({ id: node.frame.id, parentId, url: node.frame.url });
      for (const child of node.childFrames ?? []) walk(child, node.frame.id);
    };
    walk(frameTree);
    return out;
  }

  private async world(sessionId: string, frameId: string): Promise<number> {
    const key = `${sessionId}/${frameId}`;
    let contextId = this.worlds.get(key);
    if (contextId === undefined) {
      ({ executionContextId: contextId } = await this.connection.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId, worldName: "csv-viewer-test" }, sessionId));
      this.worlds.set(key, contextId);
    }
    return contextId;
  }

  async evaluate<T>(at: Located, expression: string): Promise<T> {
    const result = await this.connection.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, contextId: at.contextId, returnByValue: true },
      at.sessionId,
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  // Looks through every page and iframe target, and every frame of each, for one that has the selector. `trace` collects what was seen.
  async locate(selector: string, trace?: string[]): Promise<Located | undefined> {
    let found: Located | undefined;
    for (const target of await this.targets()) {
      if (!SCANNED_TARGET_TYPES.has(target.type)) {
        trace?.push(`target ${target.targetId.slice(0, 8)} ${target.type} ${short(target.url)}  (not scanned)`);
        continue;
      }
      let sessionId: string;
      try {
        sessionId = await this.attach(target.targetId);
        trace?.push(`target ${target.targetId.slice(0, 8)} ${target.type} ${short(target.url)}`);
        for (const frame of await this.frames(sessionId)) {
          let outcome: string;
          try {
            const at: Located = {
              sessionId,
              targetId: target.targetId,
              frameId: frame.id,
              contextId: await this.world(sessionId, frame.id),
              description: `${target.type} ${short(target.url, 60)} > frame ${short(frame.url, 80)}`,
            };
            const count = await this.evaluate<number>(at, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
            outcome = `${count} match(es)`;
            if (count > 0) found ??= at;
          } catch (err) {
            this.worlds.delete(`${sessionId}/${frame.id}`);
            outcome = `error: ${short(String(err), 100)}`;
          }
          trace?.push(`    frame ${frame.id.slice(0, 8)} parent ${frame.parentId?.slice(0, 8) ?? "-"} ${short(frame.url)}  ${outcome}`);
        }
      } catch (err) {
        trace?.push(`    could not scan: ${short(String(err), 120)}`);
      }
      if (found && !trace) return found;
    }
    return found;
  }

  async count(at: Located, selector: string): Promise<number> {
    return this.evaluate<number>(at, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }

  // Polls until the selector is found; on a timeout the error says what every target and frame looked like.
  async waitFor(selector: string, timeoutMs = 20000): Promise<Located> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.locate(selector);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no frame contains "${selector}" after ${timeoutMs}ms.\n${await this.describe(selector)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async describe(selector: string): Promise<string> {
    const lines: string[] = [];
    try {
      lines.push(`/json/version: ${short(await getText(this.port, "/json/version"), 300).replace(/\s+/g, " ")}`);
      const list = JSON.parse(await getText(this.port, "/json/list")) as { id: string; type: string; url: string }[];
      lines.push(`/json/list (${list.length}):`, ...list.slice(0, 20).map((t) => `  ${t.id.slice(0, 8)} ${t.type} ${short(t.url)}`));
      lines.push("scan:");
      await this.locate(selector, lines);
    } catch (err) {
      lines.push(`describe failed: ${String(err)}`);
    }
    return lines.join("\n").slice(0, 8000);
  }

  async focus(at: Located, selector: string): Promise<void> {
    const ok = await this.evaluate<boolean>(at, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus(); return document.activeElement === e; })()`);
    if (!ok) throw new Error(`could not focus "${selector}" in ${at.description}`);
  }

  // Sends a real key press. It is tried on the session that owns the frame first, then on the pages; the first one after which the frame
  // has seen the keydown (an observer in the frame says so) is taken, so a key is never sent twice once it has landed.
  async press(at: Located, key: KeySpec): Promise<string> {
    await this.evaluate(at, RECORDER);
    const pages = (await this.targets()).filter((t) => t.type === "page");
    const candidates = [at.sessionId];
    for (const page of pages) {
      const sessionId = await this.attach(page.targetId).catch(() => undefined);
      if (sessionId && !candidates.includes(sessionId)) candidates.push(sessionId);
    }
    for (const sessionId of candidates) {
      const before = await this.evaluate<number>(at, RECORDER);
      const event = { modifiers: key.modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
      await this.connection.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event }, sessionId);
      await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...event }, sessionId);
      for (let waited = 0; waited < 600; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if ((await this.evaluate<number>(at, RECORDER)) > before) return sessionId === at.sessionId ? "frame session" : "page session";
      }
    }
    throw new Error(`the key ${key.key} never reached ${at.description}:\n${await this.describe("body")}`);
  }
}
