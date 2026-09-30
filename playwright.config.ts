// Webview e2e suite: the shipped webview bundle (out/webview/main.js) driven by
// a real pointer in real Chromium, asserting the messages it posts to the
// extension host and the DOM it renders.
//
// Deliberately small: one browser, no dev server. `npm run test:webview`
// compiles first, because these specs load out/webview/main.js, not the
// TypeScript source.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src/test/webview-e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
