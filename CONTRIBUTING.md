# Contributing

## Development

```sh
npm install
npm run compile          # tsc + esbuild bundles for extension host and webview
npm run typecheck:webview
npm test                 # vitest unit tests for src/core
npm run test:webview     # Playwright e2e tests against the built webview bundle
npm run test:integration # real VS Code (Extension Host) integration tests
npm run package           # produces the .vsix
```

A sample file with quoted commas, embedded newlines, numbers, and empty cells is at
`samples/people.csv` for manual testing.

### Icon

`media/icon.png` (the extension icon, 128×128) is rendered from `media/icon.svg` with
the cached Playwright Chromium:

```sh
node scripts/render-icon.mjs
```

### Engineering notes

Implementation details that don't belong in the user-facing README or CHANGELOG —
quote-handling edge cases, case-folding (Turkish İ, German ß), the `__proto__` header
safety fix, the regex-timeout watchdog, the Web Worker architecture — live in
`docs/spec.md` and `docs/engineering-notes-*.md`.

## Installing from a `.vsix`

Build the package with `npm run package`, which produces `csv-viewer-<version>.vsix`.

**VS Code:** Extensions view → `···` menu → **Install from VSIX…** → select the file.
Or from the command line: `code --install-extension csv-viewer-<version>.vsix`.

**Cursor / Windsurf:** Extensions view → `···` menu → **Install from VSIX…** → select
the file. Or from the command line: `cursor --install-extension csv-viewer-<version>.vsix`
(or `windsurf --install-extension ...`).

## Publishing

Package once and publish the same file to both registries:

```sh
npm run compile
npx vsce package --no-dependencies
npx vsce publish --no-dependencies --packagePath csv-viewer-<version>.vsix
npx ovsx publish csv-viewer-<version>.vsix -p $OVSX_PAT
```

`--no-dependencies` is correct because `papaparse` is bundled into
`out/webview/*.js` by esbuild — the packaged extension never needs `node_modules` at
runtime. Verify the package contents with `npx vsce ls --no-dependencies` before
publishing; it should list exactly the runtime files (`package.json`, `README.md`,
`CHANGELOG.md`, `LICENSE`, `media/icon.png`, and `out/extension.js` plus
`out/webview/*`), nothing from `src/`, `docs/`, `scripts/`, or any tsconfig.

The release workflow (`.github/workflows/release.yml`) does this automatically on a
`v*` tag, when the `VSCE_PAT` / `OVSX_PAT` repository secrets are set.
