// Compares the timing tables that scale.spec.ts prints (one or more runs, concatenated) with docs/perf-baseline.json.
// Usage: node scripts/perf-compare.mjs <scale-log> [baseline.json]. Exits 1 only when a median is more than twice its baseline.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const [logPath, baselinePath = path.join(here, "..", "docs", "perf-baseline.json")] = process.argv.slice(2);
if (!logPath) {
  console.error("usage: node scripts/perf-compare.mjs <scale-log> [baseline.json]");
  process.exit(2);
}

const LABELS = [
  ["inPageFirstRenderMs", /^first render \(in-page/],
  ["sortMs", /^sort by /],
  ["sortInPageMs", /^sort \(in-page/],
  ["filterMs", /^filter:/],
  ["nextPageMs", /^pagination: Next page/],
  ["separatorMs", /^separator:/],
];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// The scale spec prints one table per run: the file is loaded as bytes, as VS Code delivers it.
const KEY = "scale200kx30";
const samples = { [KEY]: Object.fromEntries(LABELS.map(([label]) => [label, []])) };
let current = null;
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  if (/timing table:/.test(line)) current = KEY;
  const match = /^\s+(\S.*?)\s{2,}(\d+)\s*$/.exec(line);
  if (!match || !current) continue;
  const hit = LABELS.find(([, pattern]) => pattern.test(match[1]));
  if (hit) samples[current][hit[0]].push(Number(match[2]));
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const FACTOR = 2;
let failed = false;
console.log(`200k x 30 timing medians against ${baselinePath} (${baseline.machine})`);
for (const [label] of LABELS) {
  const runs = samples[KEY][label];
  if (runs.length === 0) {
    console.log(`  ${label.padEnd(22)} no samples in ${logPath}`);
    failed = true;
    continue;
  }
  const measured = median(runs);
  const reference = baseline[KEY][label];
  const over = measured > FACTOR * reference;
  if (over) failed = true;
  console.log(`  ${label.padEnd(22)} median ${String(measured).padStart(5)} ms of ${runs.length} run(s), baseline ${String(reference).padStart(5)} ms${over ? `  <-- over ${FACTOR}x` : ""}`);
}
process.exit(failed ? 1 : 0);
