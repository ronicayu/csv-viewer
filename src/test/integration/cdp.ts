import { chromium, type Browser, type Frame, type Page } from "playwright-core";

// VS Code drops key events a webview forwards unless they are trusted, and a script cannot make a trusted one.
// The test VS Code is launched with a debugging port (runTest.ts) so real key presses can be sent through the protocol.
export const CDP_PORT_ENV = "CSV_VIEWER_CDP_PORT";

export const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

export class WorkbenchDriver {
  private constructor(private readonly browser: Browser) {}

  static async connect(): Promise<WorkbenchDriver> {
    const port = process.env[CDP_PORT_ENV];
    if (!port) throw new Error(`${CDP_PORT_ENV} is not set: the test VS Code was not launched with a debugging port`);
    return new WorkbenchDriver(await chromium.connectOverCDP(`http://127.0.0.1:${port}`));
  }

  private pages(): Page[] {
    return this.browser.contexts().flatMap((context) => context.pages());
  }

  // The webview's content frame is nested inside the workbench page; find the one that currently holds `selector`.
  async frameWith(selector: string, timeoutMs = 15000): Promise<{ page: Page; frame: Frame }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const page of this.pages()) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          try {
            if ((await frame.locator(selector).count()) > 0) return { page, frame };
          } catch {
            // a frame that is navigating or already gone
          }
        }
      }
      if (Date.now() > deadline) throw new Error(`no webview frame contains "${selector}"`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async close(): Promise<void> {
    // For a browser we only connected to, this drops the connection and leaves VS Code running.
    await this.browser.close();
  }
}
