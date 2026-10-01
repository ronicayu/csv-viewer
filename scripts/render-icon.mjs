// Renders media/icon.svg to media/icon.png at exactly 128x128 using the
// Playwright-managed Chromium that's already cached for the webview e2e
// suite (no extra browser download needed). Run with:
//
//   node scripts/render-icon.mjs
//
// This is a build-time tool only (see .vscodeignore's scripts/** entry) —
// nothing here ships in the extension.
import { chromium } from "@playwright/test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const svgPath = path.join(here, "..", "media", "icon.svg");
const pngPath = path.join(here, "..", "media", "icon.png");

async function main() {
  const svg = readFileSync(svgPath, "utf8");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8" /><style>
        html, body { margin: 0; padding: 0; background: transparent; }
        svg { display: block; width: 128px; height: 128px; }
      </style></head><body>${svg}</body></html>`,
    );
    // The outer <rect> fills the full 128x128 viewBox, so no screenshot
    // clipping is needed beyond the viewport itself. omitBackground keeps
    // the page's own (transparent) background rather than defaulting to
    // white, so corners outside the rounded rect stay transparent.
    await page.screenshot({ path: pngPath, omitBackground: true });
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${pngPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
