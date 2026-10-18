import * as fs from "fs";
import * as path from "path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import * as net from "net";
import { CDP_PORT_ENV } from "./cdp";
import { prepareWorkspaceFixtures, WORKSPACE_ROOT } from "./fixtures";

const LOCAL_CACHED_VSCODE =
  "/Users/ronica/projects/markdown-collab-plugin/.vscode-test/vscode-darwin-arm64-1.139.1/Visual Studio Code.app/Contents/MacOS/Code";

async function resolveVscodeExecutablePath(): Promise<string> {
  if (fs.existsSync(LOCAL_CACHED_VSCODE)) return LOCAL_CACHED_VSCODE;
  return downloadAndUnzipVSCode("stable");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
    const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");

    await prepareWorkspaceFixtures();

    const vscodeExecutablePath = await resolveVscodeExecutablePath();
    const debugPort = await freePort();

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { CSV_VIEWER_TEST_HOOKS: "1", ITEST_GREP: process.env.ITEST_GREP, [CDP_PORT_ENV]: String(debugPort) },
      launchArgs: [
        WORKSPACE_ROOT,
        "--disable-extensions",
        // Lets a test send real (trusted) key presses to a webview; see cdp.ts.
        `--remote-debugging-port=${debugPort}`,
        // Short path: a long user-data dir path exceeds the ~103-char Unix socket limit for the IPC handle.
        "--user-data-dir=/tmp/cvst-ud",
      ],
    });
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

void main();
