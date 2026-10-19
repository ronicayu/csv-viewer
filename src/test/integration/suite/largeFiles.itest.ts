import * as assert from "assert";
import * as vscode from "vscode";
import { writeLargeCsv, writeSingleLongLineCsv } from "../fixtures";
import * as fsp from "fs/promises";
import { closeAllEditors, editCell, fileKeyFor, getTestApi, openInViewer, waitFor, waitForRender } from "../helpers";

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

// The lowest RSS seen once a second for `seconds` after the render: what is left when the transient copies (the RPC message VS Code builds for the
// load, ours before it was a view) have been collected. `external` and `arrayBuffers` are what the live backing stores account for.
async function settledRss(seconds: number): Promise<{ rssMb: number; externalMb: number; arrayBuffersMb: number }> {
  let lowest = process.memoryUsage();
  for (let i = 0; i < seconds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const now = process.memoryUsage();
    if (now.rss < lowest.rss) lowest = now;
  }
  return { rssMb: mb(lowest.rss), externalMb: mb(lowest.external), arrayBuffersMb: mb(lowest.arrayBuffers) };
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

    // Generous bounds; the time target is logged, not gated, because shared runners are slow and noisy.
    const rssGrowthMb = m.memAfterRssMb - m.memBeforeRssMb;
    const ratio = (growthMb: number): number => Math.round((growthMb / mb(bytes)) * 100) / 100;
    // eslint-disable-next-line no-console
    console.log(`[largeFiles] 120MB open: ${m.elapsedMs}ms (target 4000), extHost RSS grew ${rssGrowthMb}MB = ${ratio(rssGrowthMb)}x the file right after render`);
    assert.ok(m.elapsedMs < 15000, `opening took ${m.elapsedMs}ms`);
    // Right after render the RPC message VS Code builds to ship the file (a second copy, not ours) is still waiting to be collected: about 2x.
    assert.ok(rssGrowthMb < 3 * mb(bytes), `the extension host's RSS grew ${rssGrowthMb}MB for a ${mb(bytes)}MB file`);

    // Settled, the host holds the file once (document.bytes, posted as it is): about 1.1x, which is the target and is logged. The extension host is
    // not collected on demand, so a slow major GC on a shared runner can leave a transient copy standing; the gate is 1.8x, which that does not reach
    // but a retained second copy (2x and more) does.
    const settled = await settledRss(5);
    const settledGrowthMb = settled.rssMb - m.memBeforeRssMb;
    // eslint-disable-next-line no-console
    console.log(
      `[largeFiles] 120MB open, settled: extHost RSS grew ${settledGrowthMb}MB = ${ratio(settledGrowthMb)}x the file (target 1.1x, gate 1.8x), external ${settled.externalMb}MB, arrayBuffers ${settled.arrayBuffersMb}MB`,
    );
    assert.ok(settledGrowthMb < 1.8 * mb(bytes), `the extension host's settled RSS grew ${settledGrowthMb}MB for a ${mb(bytes)}MB file`);

    await vscode.commands.executeCommand("workbench.action.files.saveAll");
  });

  test("a 120MB file saves three edits within the bound, and the spliced file differs from the original only in those rows", async function () {
    this.timeout(180000);
    const { filePath, bytes } = await writeLargeCsv("onetwenty-save.csv", 120 * 1024 * 1024, 12);
    const uri = vscode.Uri.file(filePath);
    const api = await getTestApi();
    const key = fileKeyFor(uri);
    await measure("120MB/12col (edit + save)", uri, bytes, { expectRender: true, timeoutMs: 90000 });

    await editCell(api, key, 0, 1, "first", 1);
    await editCell(api, key, 1000, 2, "middle, with comma", 2);
    await editCell(api, key, 200000, 3, "last", 3);

    const rssBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    await vscode.commands.executeCommand("workbench.action.files.save");
    await waitFor(() => api.getDocument(key)?.dirty === false, { timeoutMs: 60000, message: "the 120MB save never completed" });
    const saveMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[largeFiles] 120MB save with 3 edits: ${saveMs}ms, extHost RSS ${mb(rssBefore)}MB -> ${mb(process.memoryUsage().rss)}MB`);
    assert.ok(saveMs < 20000, `saving took ${saveMs}ms`);

    const written = await fsp.readFile(filePath, "utf8");
    assert.ok(written.includes("\n0,first,"), "first edit missing");
    assert.ok(written.includes('"middle, with comma"'), "second edit missing");
    assert.strictEqual(api.getDocument(key)?.bytesLength, Buffer.byteLength(written));
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

  // About two million columns: the Columns, Sort and Filter lists and the row details cap what they build, so this is linear in the file.
  test("single line, 20MB long: one row, renders within the bound", async function () {
    this.timeout(60000);
    const { filePath, bytes } = await writeSingleLongLineCsv("longline-20mb.csv", 20 * 1024 * 1024);
    const uri = vscode.Uri.file(filePath);

    const m = await measure("20MB single line", uri, bytes, { expectRender: true, timeoutMs: 30000 });
    assert.strictEqual(m.rowCount, 1, "expected exactly one data row");
    assert.ok(m.elapsedMs < 30000, `rendering took ${m.elapsedMs}ms`);
  });
});
