import { describe, expect, it } from "vitest";
import { parseCsv } from "../../core/csvParse";
import { splitRecords } from "../../core/recordSpans";
import * as fake from "./fakeVscode";
import { openSession, workerReply } from "./harness";

// Deterministic, so a failure reproduces.
let seed = 987654321;
const random = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const int = (n: number): number => Math.floor(random() * n);

function randomText(delimiter: string): string {
  const columns = 1 + int(4);
  const rows = 1 + int(6);
  const atoms = ["a", "b", "1", "x y", " pad ", 'q"uote', "multi\nline", "é", "😀", "", "", "semi;colon", "pi|pe", "tab\tx"];
  const terminators = ["\n", "\r\n", "\r"];
  const lines: string[] = [];
  for (let r = 0; r <= rows; r++) {
    const count = random() < 0.2 ? Math.max(1, columns - 1 - int(2)) : random() < 0.1 ? columns + 1 : columns;
    const fields: string[] = [];
    for (let c = 0; c < count; c++) {
      let field = r === 0 ? `h${c}` : pick(atoms);
      const needs = field.includes(delimiter) || field.includes('"') || field.includes("\n") || field.startsWith(" ") || field.endsWith(" ");
      if (needs || random() < 0.15) field = `"${field.replace(/"/g, '""')}"`;
      fields.push(field);
    }
    lines.push(fields.join(delimiter));
    if (random() < 0.15) lines.push(pick(["", "   "]));
  }
  let out = random() < 0.2 ? "﻿" : "";
  lines.forEach((line, i) => {
    out += line;
    if (i < lines.length - 1 || random() < 0.6) out += pick(terminators);
  });
  return out;
}

describe("random edit, undo, redo and save sequences, some with edits landing during the write", () => {
  it("keep the file equal to the model, untouched records byte-identical, and the webview's text equal to the file", async () => {
    let files = 0;
    let edits = 0;
    let saves = 0;
    for (let iteration = 0; iteration < 300; iteration++) {
      const delimiter = pick([",", ";", "\t"]);
      const original = randomText(delimiter);
      const parsed = parseCsv(original, { delimiter });
      if (parsed.headers.length === 0 || parsed.rows.length === 0) continue;
      files++;
      const path = `/fuzz/f${iteration}.csv`;
      const s = await openSession(path, original, { delimiter });
      const model = parsed.rows.map((r) => r.slice());
      const touched = new Set<number>();
      // What the model says each stack entry did, in stack order.
      const history: { rowId: number; column: number; oldValue: string; newValue: string }[] = [];

      const editRandom = (): void => {
        const rowId = int(model.length);
        const column = int(parsed.headers.length);
        const value = Array.from({ length: int(4) }, () => pick(["a", " ", ",", ";", "\t", '"', "\n", "é", "😀", "x"])).join("");
        const result = s.tryEdit(rowId, column, value);
        if (!result.ok || !result.change) return;
        history.length = s.pointer - 1;
        history.push({ rowId, column, oldValue: model[rowId][column], newValue: value });
        model[rowId][column] = value;
        touched.add(rowId + 1);
        edits++;
      };
      const undoRandom = (): void => {
        if (s.pointer === 0) return;
        const entry = history[s.pointer - 1];
        s.undo();
        model[entry.rowId][entry.column] = entry.oldValue;
      };
      const redoRandom = (): void => {
        if (s.pointer >= s.stack.length) return;
        const entry = history[s.pointer];
        s.redo();
        model[entry.rowId][entry.column] = entry.newValue;
      };

      for (let op = 0; op < 12; op++) {
        const roll = random();
        if (roll < 0.45) editRandom();
        else if (roll < 0.58) undoRandom();
        else if (roll < 0.68) redoRandom();
        else {
          if (random() < 0.4) {
            fake.world.beforeWrite = () => {
              const duringWrite = random();
              if (duringWrite < 0.5) editRandom();
              else if (duringWrite < 0.75) undoRandom();
              else redoRandom();
            };
          }
          await s.save();
          fake.world.beforeWrite = undefined;
          saves++;
          expect(s.text, JSON.stringify({ original, file: s.file() })).toBe(s.file());
        }
      }
      for (let i = 0; i < 3 && s.dirty; i++) {
        await s.save();
        expect(s.text).toBe(s.file());
      }
      const context = JSON.stringify({ original, file: s.file(), model });
      expect(s.dirty, context).toBe(false);
      expect(parseCsv(s.file(), { delimiter }).rows, context).toEqual(model);

      // Records nobody touched are byte for byte what they were, and so is everything between records.
      const before = splitRecords(original, { delimiter, quotes: parsed.quoting });
      const saved = s.file();
      const after = splitRecords(saved, { delimiter, quotes: parsed.quoting });
      expect(after.length).toBe(before.length);
      let oldCursor = original.charCodeAt(0) === 0xfeff ? 1 : 0;
      let newCursor = saved.charCodeAt(0) === 0xfeff ? 1 : 0;
      before.forEach((record, i) => {
        expect(saved.slice(newCursor, after[i].start), context).toBe(original.slice(oldCursor, record.start));
        expect(after[i].eol).toBe(record.eol);
        if (!touched.has(i)) expect(saved.slice(after[i].start, after[i].end), context).toBe(original.slice(record.start, record.end));
        oldCursor = record.end + record.eol.length;
        newCursor = after[i].end + after[i].eol.length;
      });
      expect(saved.slice(newCursor)).toBe(original.slice(oldCursor));
      s.dispose();
    }
    expect(files).toBeGreaterThan(250);
    expect(edits).toBeGreaterThan(500);
    expect(saves).toBeGreaterThan(300);
  }, 120000);
});

describe("padded rows, quotes off, multi-character separators and webview reloads in the middle", () => {
  it("leave the file equal to the table the webview shows", async () => {
    let runs = 0;
    let accepted = 0;
    let reloads = 0;
    for (let iteration = 0; iteration < 400; iteration++) {
      const format = pick([
        { delimiter: ",", quotes: true },
        { delimiter: ";", quotes: true },
        { delimiter: "||", quotes: true },
        { delimiter: ",", quotes: false },
        { delimiter: "||", quotes: false },
      ]);
      const cell = (): string => pick(["a", "b", "x y", "|", "q|", "1", "é"]);
      const rows = 1 + int(4);
      const lines = [["h1", "h2", "h3"].join(format.delimiter)];
      for (let r = 0; r < rows; r++) lines.push(Array.from({ length: random() < 0.5 ? 1 : 1 + int(3) }, cell).join(format.delimiter));
      const original = lines.join(pick(["\n", "\r\n"])) + pick(["", "\n"]);
      const before = parseCsv(original, { delimiter: format.delimiter, quotes: format.quotes });
      if (before.rows.length !== rows) continue;
      runs++;
      const s = await openSession(`/fuzz2/f${iteration}.csv`, original);
      s.send({ type: "saveState", state: { ...s.of("load")[0].state, delimiter: format.delimiter, quotes: format.quotes } } as any);
      s.send({ type: "resync" } as any);
      const log: string[] = [];
      try {
        for (let step = 0; step < 16; step++) {
          const roll = random();
          if (roll < 0.5) {
            const row = int(rows);
            const column = int(3);
            const value = pick(["", "", "", "v", "|", "w|", "k"]);
            const result = s.tryEdit(row, column, value);
            if (result.ok && result.change) accepted++;
            log.push(`edit(${row},${column},${JSON.stringify(value)})=${result.ok ? "ok" : "refused"}`);
          } else if (roll < 0.62 && s.pointer > 0) {
            s.undo();
            log.push("undo");
          } else if (roll < 0.7 && s.pointer < s.stack.length) {
            s.redo();
            log.push("redo");
          } else if (roll < 0.85) {
            await s.save();
            log.push("save");
          } else {
            await s.ready();
            reloads++;
            log.push("reload");
          }
        }
        for (let i = 0; i < 3 && s.dirty; i++) await s.save();
        expect(s.dirty).toBe(false);
        const shown = workerReply({ type: "page", page: 1, pageSize: 1000 }, "pageResult").rows.map((r: { cells: string[] }) => r.cells);
        const pad = (table: string[][]): string[][] => table.map((row) => [...row, ...Array(Math.max(0, 3 - row.length)).fill("")]);
        const disk = parseCsv(s.file(), { delimiter: format.delimiter, quotes: format.quotes }).rows;
        expect(pad(disk)).toEqual(pad(shown));
        expect(s.text).toBe(s.file());
      } catch (err) {
        throw new Error(`${JSON.stringify({ original, format, log, file: s.file() })}\n${String(err)}`);
      }
      s.dispose();
    }
    expect(runs).toBeGreaterThan(300);
    expect(accepted).toBeGreaterThan(800);
    expect(reloads).toBeGreaterThan(100);
  }, 120000);
});
