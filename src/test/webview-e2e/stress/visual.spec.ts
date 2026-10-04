import { test } from "@playwright/test";
import { bootAndLoad, defaultViewState } from "../harness";
import { SCREENSHOT_DIR } from "./stressHelpers";

const VIEWPORTS = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "480x800", width: 480, height: 800 },
];

const headers = ["id", "first_and_last_name_combined", "email_address", "status", "notes", "created_at", "region"];
const rows = Array.from({ length: 12 }, (_, i) => [
  String(i + 1),
  `Person Number ${i + 1} With A Fairly Long Display Name`,
  `person${i + 1}@example-company-with-a-long-domain-name.example`,
  i % 3 === 0 ? "active" : "inactive",
  i === 0 ? "Some notes here.\nSecond line of notes." : "",
  "2026-01-01T00:00:00Z",
  i % 2 === 0 ? "NA" : "EMEA",
]);

for (const vp of VIEWPORTS) {
  test.describe(`visual @ ${vp.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await bootAndLoad(page, {
        fileKey: "file:///visual.csv",
        headers,
        rows,
        state: defaultViewState(),
        defaultTableColumns: 5,
      });
      // Without a VS Code host the --vscode-* variables are unset and popovers render transparent.
      await page.addStyleTag({
        content: `:root {
          --vscode-editor-foreground: #1e1e1e;
          --vscode-editor-background: #ffffff;
          --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          --vscode-font-size: 13px;
          --vscode-button-foreground: #ffffff;
          --vscode-button-background: #007acc;
          --vscode-button-border: transparent;
          --vscode-button-hoverBackground: #005a9e;
          --vscode-input-foreground: #1e1e1e;
          --vscode-input-background: #ffffff;
          --vscode-input-border: #cecece;
          --vscode-panel-border: #d4d4d4;
          --vscode-focusBorder: #007acc;
          --vscode-descriptionForeground: #717171;
          --vscode-dropdown-background: #ffffff;
          --vscode-dropdown-border: #cecece;
          --vscode-widget-shadow: rgba(0, 0, 0, 0.16);
          --vscode-list-hoverBackground: #f0f0f0;
          --vscode-errorForeground: #a1260d;
        }`,
      });
    });

    test(`default state @ ${vp.name}`, async ({ page }) => {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/default-${vp.name}.png`, fullPage: false });
    });

    test(`filters open @ ${vp.name}`, async ({ page }) => {
      await page.locator("#filters-btn").click();
      await page.locator("#add-rule-btn").click();
      await page.screenshot({ path: `${SCREENSHOT_DIR}/filters-open-${vp.name}.png`, fullPage: false });
    });

    test(`columns popover open @ ${vp.name}`, async ({ page }) => {
      await page.locator("#columns-btn").click();
      await page.screenshot({ path: `${SCREENSHOT_DIR}/columns-open-${vp.name}.png`, fullPage: false });
    });

    test(`expanded row @ ${vp.name}`, async ({ page }) => {
      await page.locator("tr.data-row").first().click();
      await page.screenshot({ path: `${SCREENSHOT_DIR}/expanded-row-${vp.name}.png`, fullPage: false });
    });
  });
}
