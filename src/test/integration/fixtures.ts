import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

export const WORKSPACE_ROOT = path.join(os.tmpdir(), "csv-viewer-itest-workspace");
export const LARGE_ROOT = path.join(os.tmpdir(), "csv-viewer-itest-large");

const SMALL_CSV = "id,name,note\n1,Alice,hello\n2,Bob,world\n3,Carol,\n";
const SMALL_TSV = "id\tname\tnote\n1\tAlice\thello\n2\tBob\tworld\n";

async function ensureCleanDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
}

export async function prepareWorkspaceFixtures(): Promise<Record<string, string>> {
  await ensureCleanDir(WORKSPACE_ROOT);

  const paths: Record<string, string> = {};

  const write = async (name: string, content: string | Buffer): Promise<void> => {
    const p = path.join(WORKSPACE_ROOT, name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
    paths[name] = p;
  };

  await write("sample.csv", SMALL_CSV);
  await write("sample.tsv", SMALL_TSV);
  await write("sample.tab", SMALL_TSV);
  await write("UPPER.CSV", SMALL_CSV);
  await write("empty.csv", "");
  await write("latin1.csv", Buffer.from("name,note\ncaf\xe9,clich\xe9\nna\xefve,ok\n", "latin1"));
  await write("weird names/na me #1 100% ünïçode ✓.csv", SMALL_CSV);
  await write("renameme.csv", SMALL_CSV);
  await write("fileA.csv", "id,name\n1,Alice\n2,Bob\n3,Carol\n4,Dave\n");
  await write("fileB.csv", "sku,qty\nA1,10\nA2,20\nA3,30\n");
  await write("live.csv", "id,val\n1,a\n2,b\n");
  await write("sidebyside.csv", "id,val\n1,a\n2,b\n");
  await write("columns7.csv", "a,b,c,d,e,f,g\n1,2,3,4,5,6,7\n");

  return paths;
}

export async function writeLargeCsv(name: string, targetBytes: number, cols = 12): Promise<{ filePath: string; bytes: number }> {
  await fsp.mkdir(LARGE_ROOT, { recursive: true });
  const filePath = path.join(LARGE_ROOT, name);
  const header = Array.from({ length: cols }, (_, i) => `col_${i}`).join(",") + "\n";
  const rowPrefix = Array.from({ length: cols }, (_, i) => `v${i}`).join(",");

  const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.write(header, (err) => (err ? reject(err) : undefined));

    let written = header.length;
    let rowIndex = 0;
    const CHUNK_ROWS = 2000;

    function writeChunk(): void {
      let chunk = "";
      for (let i = 0; i < CHUNK_ROWS && written < targetBytes; i++) {
        const line = `${rowIndex},${rowPrefix}\n`;
        chunk += line;
        written += line.length;
        rowIndex++;
      }
      if (chunk.length === 0 || written >= targetBytes) {
        if (chunk.length > 0) stream.write(chunk);
        stream.end(() => resolve());
        return;
      }
      const canContinue = stream.write(chunk);
      if (canContinue) setImmediate(writeChunk);
      else stream.once("drain", writeChunk);
    }
    writeChunk();
  });

  const stat = await fsp.stat(filePath);
  return { filePath, bytes: stat.size };
}

export async function writeSingleLongLineCsv(name: string, targetBytes: number): Promise<{ filePath: string; bytes: number }> {
  await fsp.mkdir(LARGE_ROOT, { recursive: true });
  const filePath = path.join(LARGE_ROOT, name);
  const cell = "x".repeat(9) + ",";
  const repeats = Math.ceil(targetBytes / cell.length);
  const line = cell.repeat(repeats).replace(/,$/, "");
  await fsp.writeFile(filePath, "header\n" + line + "\n");
  const stat = await fsp.stat(filePath);
  return { filePath, bytes: stat.size };
}

export async function cleanupFixtures(): Promise<void> {
  await fsp.rm(WORKSPACE_ROOT, { recursive: true, force: true });
  await fsp.rm(LARGE_ROOT, { recursive: true, force: true });
}
