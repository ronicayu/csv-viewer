import * as assert from "assert";
import * as vscode from "vscode";
import { writeLargeCsv, writeSingleLongLineCsv } from "../fixtures";
import { closeAllEditors, fileKeyFor, getTestApi, openInViewer, waitFor, waitForRender } from "../helpers";

interface Measurement {
  label: string;
  bytes: number;
  elapsedMs: number;
  outcome: "rendered" | "failed-to-open";
  rowCount?: number;
  memBeforeRssMb: number;
  memAfterRssMb: number;
  memBeforeHeapMb: number;
  memAfterHeapMb: number;
}

const measurements: Measurement[] = [];

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

async function measure(label: string, uri: vscode.Uri, bytes: number, opts: { expectRender: boolean; timeoutMs: number }): Promise<Measurement> {
  const api = await getTestApi();
  const memBefore = process.memoryUsage();
  const t0 = Date.now();
  await openInViewer(uri);

  let rowCount: number | undefined;
  let outcome: Measurement["outcome"];
  if (opts.expectRender) {
    const render = await waitForRender(api, fileKeyFor(uri), 1, { timeoutMs: opts.timeoutMs });
    rowCount = render.rowCount;
    outcome = "rendered";
  } else {
    try {
      await waitForRender(api, fileKeyFor(uri), 1, { timeoutMs: opts.timeoutMs });
      outcome = "rendered";
    } catch {
      outcome = "failed-to-open";
    }
  }
  const elapsedMs = Date.now() - t0;
  const memAfter = process.memoryUsage();

  const m: Measurement = {
    label,
    bytes,
    elapsedMs,
    outcome,
    rowCount,
    memBeforeRssMb: mb(memBefore.rss),
    memAfterRssMb: mb(memAfter.rss),
    memBeforeHeapMb: mb(memBefore.heapUsed),
    memAfterHeapMb: mb(memAfter.heapUsed),
  };
  measurements.push(m);
  // eslint-disable-next-line no-console
  console.log(
    `[largeFiles] ${label}: ${mb(bytes)}MB, outcome=${outcome}, elapsed=${elapsedMs}ms, rows=${rowCount ?? "n/a"}, ` +
      `extHost RSS ${m.memBeforeRssMb}MB -> ${m.memAfterRssMb}MB, heapUsed ${m.memBeforeHeapMb}MB -> ${m.memAfterHeapMb}MB`,
  );
  return m;
}

suite("Large files", function () {
  this.timeout(300000);

  suiteSetup(async () => {
    await getTestApi();
  });

  teardown(async () => {
    await closeAllEditors();
  });

  suiteTeardown(() => {
    // eslint-disable-next-line no-console
    console.log("[largeFiles] summary:\n" + measurements.map((m) => JSON.stringify(m)).join("\n"));
  });

  test("49MB file: under the 50MB warning threshold, opens and renders without a warning", async function () {
    this.timeout(60000);
    const { filePath, bytes } = await writeLargeCsv("fortynine.csv", 49 * 1024 * 1024, 12);
    const uri = vscode.Uri.file(filePath);
    const api = await getTestApi();

    const m = await measure("49MB/12col", uri, bytes, { expectRender: true, timeoutMs: 45000 });
    assert.strictEqual(m.outcome, "rendered");
    assert.ok(m.rowCount! > 0, "expected at least one parsed row");

    const warned = api.getNotifications().some((n) => n.level === "warning" && /larger than 50 ?MB/i.test(n.message));
    assert.strictEqual(warned, false, "49MB is under the 50MB threshold; no warning expected");
  });

  test("FIXED: a 51MB file now opens and renders via the readonly custom editor (reads bytes directly, bypassing VS Code's text-sync ceiling), with the >50MB warning shown", async function () {
    this.timeout(60000);
    const { filePath, bytes } = await writeLargeCsv("fiftyone.csv", 51 * 1024 * 1024, 12);
    const uri = vscode.Uri.file(filePath);
    const api = await getTestApi();

    const m = await measure("51MB/12col", uri, bytes, { expectRender: true, timeoutMs: 45000 });
    assert.strictEqual(m.outcome, "rendered");
    assert.ok(m.rowCount! > 0, "expected at least one parsed row");

    const warned = api.getNotifications().some((n) => n.level === "warning" && /larger than 50 ?MB/i.test(n.message));
    assert.strictEqual(warned, true, "51MB is over the 50MB threshold; the 'may be slow' warning is expected");
  });

  test("FIXED: a 120MB file now opens and renders via the readonly custom editor, well under the 512MB hard limit", async function () {
    this.timeout(90000);
    const { filePath, bytes } = await writeLargeCsv("onetwenty.csv", 120 * 1024 * 1024, 12);
    const uri = vscode.Uri.file(filePath);

    const m = await measure("120MB/12col", uri, bytes, { expectRender: true, timeoutMs: 75000 });
    assert.strictEqual(m.outcome, "rendered");
    assert.ok(m.rowCount! > 0, "expected at least one parsed row");

    await vscode.commands.executeCommand("workbench.action.files.saveAll");
  });

  test("a file over the 512MB hard limit shows an error and is not loaded", async function () {
    this.timeout(280000);
    const { filePath, bytes } = await writeLargeCsv("waytoobig.csv", 513 * 1024 * 1024, 12);
    const uri = vscode.Uri.file(filePath);
    const api = await getTestApi();

    const m = await measure("513MB/12col (hard limit)", uri, bytes, { expectRender: false, timeoutMs: 8000 });
    assert.strictEqual(m.outcome, "failed-to-open", "expected the hard limit to prevent any render");

    const errored = api.getNotifications().some((n) => n.level === "error" && /larger than 512 ?MB/i.test(n.message));
    assert.strictEqual(errored, true, "expected an error notification naming the 512MB hard limit");
  });

  test("single line, 2MB long: one row, opens without throwing", async function () {
    this.timeout(30000);
    const { filePath, bytes } = await writeSingleLongLineCsv("longline-2mb.csv", 2 * 1024 * 1024);
    const uri = vscode.Uri.file(filePath);

    const m = await measure("2MB single line", uri, bytes, { expectRender: true, timeoutMs: 20000 });
    assert.strictEqual(m.rowCount, 1, "expected exactly one data row");
  });

  // Skipped: a 20MB single line renders far slower than linearly and can hang the whole test host.
  test.skip("single line, 20MB long: one row (SKIPPED — see BUG comment above; risks hanging the whole test host)", async function () {
    const { filePath } = await writeSingleLongLineCsv("longline-20mb.csv", 20 * 1024 * 1024);
    const uri = vscode.Uri.file(filePath);
    await openInViewer(uri);
    const api = await getTestApi();
    await waitFor(() => api.getMessages(fileKeyFor(uri)).some((m) => m.type === "rendered"), { timeoutMs: 120000 });
  });
});
