# Contributing

## Development

```sh
npm install
npm run compile          # tsc + esbuild bundles for extension host and webview
npm run typecheck:webview
npm test                 # vitest unit tests for src/core
npm run test:webview     # Playwright e2e tests against the built webview bundle
npm run test:integration # real VS Code (Extension Host) integration tests
npm run test:perf        # strict performance assertions for the same two suites above
npm run package           # produces the .vsix
```

Four test suites, in increasing order of cost:

- `npm test` — vitest unit tests for `src/core`. Fast; run this constantly while
  working.
- `npm run test:webview` — Playwright e2e tests against the built webview bundle
  (`src/webview/**`).
- `npm run test:integration` — real VS Code (Extension Host) integration tests.
  This one spins up an actual VS Code instance and can time out when the machine
  it's running on is under heavy load (CI contention, another build running, a
  loaded dev machine, etc.). If it times out, retry it rather than editing the
  test or the code to "fix" the timeout — a flaky timeout under load is a
  property of the environment, not a bug the suite is catching.
- `npm run test:perf` — re-runs the webview scale spec and the vitest stress
  suite with `PERF_TESTS=1`, switching their assertions from generous bounds to
  strict wall-clock targets (first render/filter/sort/page timings, the
  500k-row multi-key sort ceiling, etc. — see `docs/spec.md`'s Acceptance
  section). Run this one **alone, on an otherwise-quiet machine**: anything else
  competing for CPU can push real work past these targets without any
  regression in the code itself, so a `test:perf` failure under load isn't
  necessarily a finding. It isn't part of the normal edit/test loop above —
  reach for it specifically when you need to check a performance-sensitive
  change.

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

Build the package with `npm run package`, which produces `csv-row-details-<version>.vsix`.

**VS Code:** Extensions view → `···` menu → **Install from VSIX…** → select the file.
Or from the command line: `code --install-extension csv-row-details-<version>.vsix`.

**Cursor / Windsurf:** Extensions view → `···` menu → **Install from VSIX…** → select
the file. Or from the command line: `cursor --install-extension csv-row-details-<version>.vsix`
(or `windsurf --install-extension ...`).

## Publishing

Package once and publish the same file to both registries:

```sh
npm run compile
npx vsce package --no-dependencies
npx vsce publish --no-dependencies --packagePath csv-row-details-<version>.vsix
npx ovsx publish csv-row-details-<version>.vsix -p $OVSX_PAT
```

`--no-dependencies` is correct because `papaparse` and `markdown-it` are bundled into
`out/webview/*.js` by esbuild — the packaged extension never needs `node_modules` at
runtime. Verify the package contents with `npx vsce ls --no-dependencies` before
publishing; it should list exactly the runtime files (`package.json`, `README.md`,
`CHANGELOG.md`, `LICENSE`, `media/icon.png`, and `out/extension.js` plus
`out/webview/*`), nothing from `src/`, `docs/`, `scripts/`, or any tsconfig.

The release workflow (`.github/workflows/release.yml`) does this automatically on a
`v*` tag, when the `VSCE_PAT` / `OVSX_PAT` repository secrets are set.
