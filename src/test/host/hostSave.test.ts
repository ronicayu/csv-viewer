import { describe, expect, it } from "vitest";
import { parseCsv } from "../../core/csvParse";
import * as fake from "./fakeVscode";
import { callWorker, openSession, Session, tick, workerReply } from "./harness";

const text = (path: string): string => fake.readFileText(path);

describe("save", () => {
  it("splices only the edited records, rebases, and a later edit lands on the right record", async () => {
    const original = '﻿id,name,note\r\n1,"Smith, A",hello\n\n2,Bob\r\n3,"multi\nline",x';
    const s = await openSession("/h/a.csv", original);
    expect(s.of("load")[0]).toMatchObject({ editable: true, baseVersion: 1, text: original });

    s.edit(0, 1, "Smith B");
    s.edit(1, 2, "added");
    expect(s.host.api.getDocument(s.key)).toMatchObject({ dirty: true, editCount: 2 });

    await s.save();
    expect(text("/h/a.csv")).toBe('﻿id,name,note\r\n1,Smith B,hello\n\n2,Bob,added\r\n3,"multi\nline",x');
    expect(s.of("saved")[0]).toMatchObject({ baseVersion: 2, written: [{ recordIndex: 1, fields: ["1", "Smith B", "hello"] }, { recordIndex: 2, fields: ["2", "Bob", "added"] }] });
    expect(s.host.api.getDocument(s.key)).toMatchObject({ dirty: false, baseVersion: 2 });
    expect(s.text).toBe(text("/h/a.csv"));

    s.edit(2, 2, "tail, with comma");
    await s.save();
    expect(text("/h/a.csv")).toBe('﻿id,name,note\r\n1,Smith B,hello\n\n2,Bob,added\r\n3,"multi\nline","tail, with comma"');
    expect(s.text).toBe(text("/h/a.csv"));
  });

  it("writes nothing when there are no edits", async () => {
    const s = await openSession("/h/b.csv", "a,b\n1,2\n");
    const mtime = fake.world.files.get("/h/b.csv")!.mtime;
    await s.save();
    expect(fake.world.files.get("/h/b.csv")!.mtime).toBe(mtime);
  });

  it("an edit committed while the save is writing is still dirty afterwards and later edits hit the right row", async () => {
    const s = await openSession("/h/race1.csv", "h,v\n1,a\nx,y\nx,y\nx,y\n");
    s.edit(0, 1, "b");
    fake.world.beforeWrite = () => {
      s.edit(0, 1, "bbbbb");
    };
    await s.save();
    expect(text("/h/race1.csv")).toBe("h,v\n1,b\nx,y\nx,y\nx,y\n");
    // The write had only "b"; "bbbbb" is a new edit against it.
    expect(s.dirty).toBe(true);

    s.edit(2, 1, "Z");
    await s.save();
    expect(text("/h/race1.csv")).toBe("h,v\n1,bbbbb\nx,y\nx,Z\nx,y\n");
    expect(s.dirty).toBe(false);
  });

  it("an undo during the write is applied against the written baseline, not lost", async () => {
    const s = await openSession("/h/race2.csv", "h,v\n1,a\nx,y\nx,y\nx,y\n");
    s.edit(0, 1, "aaaaa");
    fake.world.beforeWrite = () => {
      s.undo();
    };
    await s.save();
    expect(text("/h/race2.csv")).toBe("h,v\n1,aaaaa\nx,y\nx,y\nx,y\n");
    expect(s.dirty).toBe(true);
    s.edit(2, 1, "Z");
    await s.save();
    expect(text("/h/race2.csv")).toBe("h,v\n1,a\nx,y\nx,Z\nx,y\n");
  });

  it("tells VS Code the document is still dirty when edits landed during the write", async () => {
    const s = await openSession("/h/race3.csv", "h,v\n1,a\n");
    const content: unknown[] = [];
    s.host.provider.onDidChangeCustomDocument((e: any) => {
      if (!e.undo) content.push(e);
    });
    s.edit(0, 1, "b");
    fake.world.beforeWrite = () => {
      s.edit(0, 1, "c");
    };
    await s.save();
    await tick(10);
    expect(content).toHaveLength(1);
  });

  it("an edit sent against the old base just after the save is accepted", async () => {
    const s = await openSession("/h/late.csv", "h,v\n1,a\n2,b\n3,c\n");
    s.edit(0, 1, "A");
    // Made before the webview saw `saved`, so it carries the old base and the old spans.
    const late = workerReply({ type: "editCell", rowId: 2, columnIndex: 1, value: "CCC" }, "editResult");
    await s.save();
    s.send({ type: "edit", baseVersion: 1, change: late.change });
    expect(s.dirty).toBe(true);
    await s.save();
    expect(text("/h/late.csv")).toBe("h,v\n1,A\n2,b\n3,CCC\n");
  });

  it("an edit for a base two saves back is dropped and answered with a load", async () => {
    const s = await openSession("/h/stale.csv", "h,v\n1,a\n");
    const change = s.edit(0, 1, "x");
    await s.save();
    s.edit(0, 1, "y");
    await s.save();
    const loads = s.of("load").length;
    s.send({ type: "edit", baseVersion: 1, change });
    expect(s.of("load").length).toBe(loads + 1);
  });

  it("two overlapping saves run one after the other and do not raise a changed-on-disk prompt", async () => {
    const s = await openSession("/h/two.csv", "h,v\n1,a\n");
    s.edit(0, 1, "b");
    fake.world.beforeWrite = async () => {
      await tick(20);
    };
    const first = s.save();
    const second = s.save();
    await Promise.all([first, second]);
    expect(fake.world.notifications.filter((n) => n.modal)).toHaveLength(0);
    expect(text("/h/two.csv")).toBe("h,v\n1,b\n");
  });

  it("host splits the held bytes itself: wrong offsets from the webview cannot move an edit to an identical record", async () => {
    const s = await openSession("/h/same.csv", "h,v\nx,y\nx,y\nx,y\n");
    const change = s.edit(2, 1, "Z");
    // A webview whose offsets pointed at the first identical record would have written there.
    expect(change.record.charStart).toBeGreaterThan(0);
    await s.save();
    expect(text("/h/same.csv")).toBe("h,v\nx,y\nx,y\nx,Z\n");
  });

  it("refuses to write when a record's text is not what the edit was made against", async () => {
    const s = await openSession("/h/guard.csv", "h,v\n1,a\n2,b\n");
    const change = JSON.parse(JSON.stringify(workerReply({ type: "editCell", rowId: 1, columnIndex: 1, value: "B" }, "editResult").change));
    change.record.originalText = "9,z";
    s.send({ type: "edit", baseVersion: 1, change });
    expect(s.dirty).toBe(true);
    await expect(s.save()).rejects.toThrow("internal consistency check failed");
    expect(text("/h/guard.csv")).toBe("h,v\n1,a\n2,b\n");
  });
});

describe("undo and redo", () => {
  it("drive applyEdits, including after a save, and the host's file follows", async () => {
    const s = await openSession("/h/u1.csv", "id,name\n1,Alice\n2,Bob\n");
    s.edit(1, 1, "Robert");
    s.undo();
    expect(s.dirty).toBe(false);
    expect(s.of("applyEdits").pop()).toMatchObject({ kind: "undo", cells: [{ rowId: 1, columnIndex: 1, value: "Bob", original: "Bob" }] });
    s.redo();
    expect(s.dirty).toBe(true);
    await s.save();
    expect(text("/h/u1.csv")).toBe("id,name\n1,Alice\n2,Robert\n");
    s.undo();
    expect(s.dirty).toBe(true);
    expect(s.of("applyEdits").pop()).toMatchObject({ baseVersion: 2, cells: [{ value: "Bob", original: "Robert" }] });
    await s.save();
    expect(text("/h/u1.csv")).toBe("id,name\n1,Alice\n2,Bob\n");
  });

  it("undo of a padded-cell edit after a save writes the original record back", async () => {
    const s = await openSession("/h/u2.csv", "a,b,c\n1\n2,3,4\n");
    s.edit(0, 2, "x");
    await s.save();
    expect(text("/h/u2.csv")).toBe("a,b,c\n1,,x\n2,3,4\n");
    s.undo();
    await s.save();
    expect(text("/h/u2.csv")).toBe("a,b,c\n1\n2,3,4\n");
    expect(s.text).toBe(text("/h/u2.csv"));
    // and the next edit still lands on the right record
    s.edit(1, 0, "two");
    await s.save();
    expect(text("/h/u2.csv")).toBe("a,b,c\n1\ntwo,3,4\n");
  });

  it("an undo entry from before a reload is a no-op", async () => {
    const s = await openSession("/h/u3.csv", "id,name\n1,Alice\n");
    s.edit(0, 1, "Al");
    await s.revert();
    const before = s.messages.length;
    s.stack[0].undo();
    expect(s.messages.length).toBe(before);
    expect(s.dirty).toBe(false);
    expect(s.of("load").pop()).toMatchObject({ baseVersion: 2, pendingEdits: [] });
  });
});

describe("format", () => {
  it("an edit made under another tokenization is refused with a load", async () => {
    const s = await openSession("/h/f1.csv", "id,name\n1,Alice\n2,Bob\n");
    s.edit(1, 1, "Robert");
    callWorker({ type: "init", text: "id,name\n1,Alice\n2,Bob\n", options: { delimiter: '"', firstRowIsHeader: true, quotes: false } });
    const loads = s.of("load").length;
    const result = s.tryEdit(1, 0, "X");
    expect(result.ok).toBe(true);
    expect(s.of("load").length).toBe(loads + 1);
    await s.save();
    expect(text("/h/f1.csv")).toBe("id,name\n1,Alice\n2,Robert\n");
  });

  it("a format change in saveState while dirty is refused: the stored state is kept and the webview is reloaded", async () => {
    const s = await openSession("/h/f2.csv", "id,name\n1,Alice\n");
    const state = s.of("load")[0].state;
    s.edit(0, 1, "Al");
    const loads = s.of("load").length;
    s.send({ type: "saveState", state: { ...state, delimiter: ";" } });
    expect(s.of("load").length).toBe(loads + 1);
    expect(s.of("load").pop().state.delimiter).toBe(state.delimiter);
  });

  it("a format change while clean discards the records, so earlier undo entries do nothing", async () => {
    const s = await openSession("/h/f3.csv", "id,name\n1,Alice\n");
    const state = s.of("load")[0].state;
    s.send({ type: "saveState", state });
    s.edit(0, 1, "Al");
    await s.save();
    s.send({ type: "saveState", state: { ...state, delimiter: ";" } });
    const before = s.messages.length;
    s.stack[0].undo();
    expect(s.messages.length).toBe(before);
  });

  it("edits are refused for a document that is not valid UTF-8", async () => {
    const s = await openSession("/h/f4.csv", new Uint8Array([0x6e, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(s.of("load")[0]).toMatchObject({ editable: false, readOnlyReason: "encoding" });
    const loads = s.of("load").length;
    s.send({
      type: "edit",
      baseVersion: 1,
      change: { rowId: 0, recordIndex: 1, columnIndex: 0, column: "n", oldValue: "caf�", newValue: "x", record: { charStart: 2, charEnd: 7, byteStart: 2, byteEnd: 7, eol: "\n", fieldCount: 1, originalText: "caf�", originalFields: ["caf�"], columns: 1 }, format: { delimiter: ",", quoting: true } },
    });
    expect(s.dirty).toBe(false);
    expect(s.of("load").length).toBe(loads + 1);
  });
});

describe("backup and restore", () => {
  it("round trips the edit list, and a restored document saves it", async () => {
    const s = await openSession("/h/k1.csv", "id,name\n1,Alice\n2,Bob\n");
    s.edit(0, 1, "Alicia");
    s.edit(1, 1, "Robert");
    const id = await s.host.api.backupDocument(s.key, fake.Uri.file("/backups/k1.json"));
    expect(await s.host.api.openDocumentFromBackup(s.doc.uri, id)).toEqual({ editCount: 2 });
    s.dispose();

    const restored = await openSession("/h/k1.csv", "", { backupId: id, existing: true });
    expect(restored.of("load")[0].pendingEdits).toEqual([
      { recordIndex: 1, originalFields: ["1", "Alice"], fields: ["1", "Alicia"] },
      { recordIndex: 2, originalFields: ["2", "Bob"], fields: ["2", "Robert"] },
    ]);
    expect(restored.dirty).toBe(true);
    await restored.save();
    expect(text("/h/k1.csv")).toBe("id,name\n1,Alicia\n2,Robert\n");
  });

  it("a short row emptied in a wide file survives a backup round trip as `,`", async () => {
    const s = await openSession("/h/k0.csv", "a,b,c\nq\nz,z,z\n");
    s.edit(0, 0, "");
    const id = await s.host.api.backupDocument(s.key, fake.Uri.file("/backups/k0.json"));
    s.dispose();
    const restored = await openSession("/h/k0.csv", "", { backupId: id, existing: true });
    expect(restored.dirty).toBe(true);
    await restored.save();
    expect(text("/h/k0.csv")).toBe("a,b,c\n,\nz,z,z\n");
  });

  it("drops the edits with one warning when the file changed", async () => {
    const s = await openSession("/h/k2.csv", "id,name\n1,Alice\n");
    s.edit(0, 1, "Al");
    const id = await s.host.api.backupDocument(s.key, fake.Uri.file("/backups/k2.json"));
    fake.putFile("/h/k2.csv", "id,name\n1,Alice\n2,New\n");
    const before = fake.world.notifications.length;
    expect(await s.host.api.openDocumentFromBackup(s.doc.uri, id)).toEqual({ editCount: 0 });
    const warnings = fake.world.notifications.slice(before);
    expect(warnings.map((w) => w.message)).toEqual([`CSV Viewer: the unsaved edits to "k2.csv" couldn't be restored because the file changed.`]);
  });

  it("a restored record that no longer matches is dropped, once", async () => {
    const s = await openSession("/h/k3.csv", "id,name\n1,Alice\n2,Bob\n");
    s.edit(0, 1, "A2");
    s.edit(1, 1, "B2");
    const id = await s.host.api.backupDocument(s.key, fake.Uri.file("/backups/k3.json"));
    s.dispose();
    // Same size and mtime, different text in the second record.
    fake.world.files.get("/h/k3.csv")!.data = new TextEncoder().encode("id,name\n1,Alice\n2,Rob\n");
    const before = fake.world.notifications.length;
    const restored = await openSession("/h/k3.csv", "", { backupId: id, existing: true });
    expect(restored.dropped).toEqual([2]);
    expect(restored.host.api.getDocument(restored.key)!.editCount).toBe(1);
    expect(fake.world.notifications.slice(before)).toHaveLength(1);
  });
});

describe("disk changes", () => {
  it("a changed file while dirty raises fileChangedOnDisk without reloading; Overwrite writes the original plus the edit", async () => {
    const s = await openSession("/h/d1.csv", "id,name\n1,Alice\n");
    s.edit(0, 1, "Mine");
    fake.putFile("/h/d1.csv", "id,name\n1,Theirs\n2,Row\n");
    const watcher = fake.world.watchers.filter((w) => !w.disposed).pop()!;
    watcher.change.fire(s.doc.uri);
    await tick(450);
    expect(s.of("fileChangedOnDisk")).toHaveLength(1);
    expect(s.of("load")).toHaveLength(1);

    const saving = s.save();
    await tick(30);
    const prompt = s.host.api.getPendingPrompt()!;
    expect(prompt).toEqual({ message: `"d1.csv" has changed on disk since you opened it. Overwrite it with your edits?`, buttons: ["Overwrite"] });
    s.host.api.choosePromptButton("Overwrite");
    await saving;
    expect(text("/h/d1.csv")).toBe("id,name\n1,Mine\n");
  });

  it("declining the overwrite fails the save and leaves the document dirty", async () => {
    const s = await openSession("/h/d2.csv", "id,name\n1,Alice\n");
    s.edit(0, 1, "Mine");
    fake.putFile("/h/d2.csv", "id,name\n1,Theirs\n");
    const saving = s.save();
    await tick(30);
    s.host.api.choosePromptButton(undefined);
    await expect(saving).rejects.toThrow("Save cancelled: the file changed on disk");
    expect(s.dirty).toBe(true);
  });

  it("a clean document reloads, and deleted-then-recreated sends fileRestored", async () => {
    const s = await openSession("/h/d3.csv", "id,name\n1,Alice\n");
    fake.putFile("/h/d3.csv", "id,name\n1,Alice\n2,Bob\n");
    const watcher = fake.world.watchers.filter((w) => !w.disposed).pop()!;
    watcher.change.fire(s.doc.uri);
    await tick(450);
    expect(s.of("load")[1]).toMatchObject({ baseVersion: 2, text: "id,name\n1,Alice\n2,Bob\n" });

    fake.world.files.delete("/h/d3.csv");
    watcher.del.fire(s.doc.uri);
    await tick(700);
    expect(s.of("fileDeleted")).toHaveLength(1);
    fake.putFile("/h/d3.csv", "id,name\n9,Zed\n");
    watcher.create.fire(s.doc.uri);
    await tick(450);
    expect(s.of("load")).toHaveLength(3);
    expect(s.of("fileRestored")).toHaveLength(1);
  });

  it("delete while dirty keeps the edits; saving recreates the file and fileRestored follows", async () => {
    const s = await openSession("/h/d4.csv", "id,name\n1,Alice\n");
    s.edit(0, 1, "Kept");
    const watcher = fake.world.watchers.filter((w) => !w.disposed).pop()!;
    fake.world.files.delete("/h/d4.csv");
    watcher.del.fire(s.doc.uri);
    await tick(700);
    expect(fake.world.notifications.some((n) => n.message.includes("Your unsaved edits are kept; saving will recreate it."))).toBe(true);
    await s.save();
    expect(text("/h/d4.csv")).toBe("id,name\n1,Kept\n");
    watcher.create.fire(s.doc.uri);
    await tick(450);
    expect(s.of("fileRestored")).toHaveLength(1);
  });
});

describe("the rest of the provider", () => {
  it("Save As writes the spliced bytes elsewhere and leaves the document alone", async () => {
    const s = await openSession("/h/s1.csv", "id,name\n1,Alice\n");
    s.edit(0, 1, "Copy");
    await s.host.api.saveDocumentAs(s.key, fake.Uri.file("/h/s1-copy.csv"));
    expect(text("/h/s1-copy.csv")).toBe("id,name\n1,Copy\n");
    expect(text("/h/s1.csv")).toBe("id,name\n1,Alice\n");
    expect(s.dirty).toBe(true);
  });

  it("read-only reasons: encoding from the bytes, setting and file system from the environment, and setEditable follows the setting", async () => {
    const a = await openSession("/h/r1.csv", "a\n1\n");
    expect(a.of("load")[0].editable).toBe(true);
    await fake.workspace.getConfiguration("csvViewer").update("editing", false);
    expect(a.of("setEditable").pop()).toMatchObject({ editable: false, readOnlyReason: "setting" });
    await fake.workspace.getConfiguration("csvViewer").update("editing", true);
    expect(a.of("setEditable").pop()).toMatchObject({ editable: true });
    fake.world.writable = false;
    const b = await openSession("/h/r2.csv", "a\n1\n");
    fake.world.writable = true;
    expect(b.of("load")[0]).toMatchObject({ editable: false, readOnlyReason: "filesystem" });
  });

  it("re-resolving a dirty document loads it with its pending edits", async () => {
    const s = await openSession("/h/p1.csv", "id,name\n1,Alice\n2,Bob\n");
    s.edit(1, 1, "Robert");
    s.closePanel();
    await s.attach({});
    await s.ready();
    expect(s.of("load").pop()).toMatchObject({ baseVersion: 1, pendingEdits: [{ recordIndex: 2, originalFields: ["2", "Bob"], fields: ["2", "Robert"] }] });
  });

  it("a visible panel whose webview never confirmed the base is sent a fresh load, a confirmed one is not", async () => {
    const s = await openSession("/h/p2.csv", "id,name\n1,Alice\n", { deferReady: true });
    s.send({ type: "ready" });
    await tick();
    const loads = () => s.of("load").length;
    expect(loads()).toBe(1);
    s.changeViewState(true);
    expect(loads()).toBe(1);
    s.baseVersion = 0;
    s.doc.syncedBase = 0;
    s.changeViewState(true);
    expect(loads()).toBe(2);
  });

  it("a resync request gets a full load, and the revert message runs VS Code's revert", async () => {
    const s = await openSession("/h/p3.csv", "id,name\n1,Alice\n");
    s.send({ type: "resync" });
    expect(s.of("load")).toHaveLength(2);
    s.send({ type: "revert" });
    expect(fake.world.commands.some((c) => c.id === "workbench.action.files.revert")).toBe(true);
  });

  it("Open as Text is refused while there are unsaved edits", async () => {
    const s = await openSession("/h/p4.csv", "id,name\n1,Alice\n");
    s.edit(0, 1, "Dirty");
    const before = fake.world.notifications.length;
    await fake.world.registered["csvViewer.openAsText"]();
    expect(fake.world.notifications.slice(before).map((n) => n.message)).toEqual(["Save or revert your edits before opening as text."]);
    expect(fake.world.commands.some((c) => c.id === "vscode.openWith" && c.args[1] === "default")).toBe(false);
  });

  it("editsDropped removes the records and warns once", async () => {
    const s = await openSession("/h/p5.csv", "id,name\n1,Alice\n2,Bob\n");
    s.edit(0, 1, "A2");
    s.edit(1, 1, "B2");
    const before = fake.world.notifications.length;
    s.send({ type: "editsDropped", recordIndexes: [2] });
    expect(s.host.api.getDocument(s.key)!.editCount).toBe(1);
    expect(fake.world.notifications.slice(before)).toHaveLength(1);
  });

  it("disposing the document disposes its watcher and forgets it", async () => {
    const s = await openSession("/h/p6.csv", "id,name\n1,Alice\n");
    const watcher = fake.world.watchers.filter((w) => !w.disposed).pop()!;
    s.dispose();
    expect(watcher.disposed).toBe(true);
    expect(s.host.api.getDocument(s.key)).toBeUndefined();
  });

  it("a missing file reports the read error once on ready and loads nothing", async () => {
    const s = await openSession("/h/missing.csv", "x", { deferReady: true });
    fake.world.files.delete("/h/missing.csv");
    // The file vanished after the document was opened, so open a fresh one.
    s.dispose();
    const host = s.host;
    const doc = await host.provider.openCustomDocument(fake.Uri.file("/h/missing.csv"), {}, (await import("./harness")).token);
    const missing = new (s.constructor as any)(host, doc, "/h/missing.csv");
    await missing.attach({});
    const before = fake.world.notifications.length;
    await missing.ready();
    const errors = fake.world.notifications.slice(before).filter((n) => n.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('CSV Viewer: could not read "missing.csv"');
    expect(missing.of("load")).toHaveLength(0);
  });

  it("a padded-cell edit extends the record only as far as the edited cell", async () => {
    const s = await openSession("/h/q1.csv", "a,b,c\n1\n");
    s.edit(0, 2, "x");
    await s.save();
    expect(text("/h/q1.csv")).toBe("a,b,c\n1,,x\n");
  });
});

describe("one owner for a record's floor", () => {
  it("survives a webview reload: emptying a once-padded row keeps it as a row of empty fields", async () => {
    const s = await openSession("/h/floor.csv", "a,b,c\nq\nz,z,z\n");
    s.edit(0, 2, "x");
    await s.save();
    expect(text("/h/floor.csv")).toBe("a,b,c\nq,,x\nz,z,z\n");

    await s.ready();
    expect(s.of("load").at(-1).recordFloors).toEqual([{ recordIndex: 1, floor: 1 }]);
    s.edit(0, 2, "");
    // One empty field would be a blank line and the row would be gone on reopening, so the row is written as two.
    expect(s.tryEdit(0, 0, "")).toMatchObject({ ok: true });
    await s.save();
    expect(text("/h/floor.csv")).toBe("a,b,c\n,\nz,z,z\n");
    expect(parseCsv(text("/h/floor.csv")).rows).toEqual([["", "", ""], ["z", "z", "z"]]);
    expect(s.text).toBe(text("/h/floor.csv"));
    expect(workerReply({ type: "page", page: 1, pageSize: 10 }, "pageResult").rows[0].cells).toEqual(["", "", ""]);
  });

  it("a short row emptied in a wide file is written as `,` and undoing it writes the original bytes back", async () => {
    const s = await openSession("/h/short.csv", "a,b,c\nq\nz,z,z\n");
    s.edit(0, 0, "");
    await s.save();
    expect(text("/h/short.csv")).toBe("a,b,c\n,\nz,z,z\n");
    s.undo();
    expect(s.dirty).toBe(true);
    await s.save();
    expect(text("/h/short.csv")).toBe("a,b,c\nq\nz,z,z\n");

    // before any save, undo is simply clean
    s.edit(0, 0, "");
    s.undo();
    expect(s.dirty).toBe(false);
  });

  it("a one-column file's row still cannot be emptied, and the worker says why", async () => {
    const s = await openSession("/h/onecol.csv", "n\nq\nz\n");
    expect(s.tryEdit(0, 0, "")).toMatchObject({ ok: false, reason: "an empty value would leave this row empty, which removes it from the file" });
  });

  it("is also handed back after a hot-exit style restore and a worker re-init", async () => {
    const s = await openSession("/h/floor2.csv", "a,b,c\nq\nz,z,z\n");
    s.edit(0, 2, "x");
    await s.save();
    s.edit(0, 0, "w");
    await s.ready();
    expect(s.of("load").at(-1)).toMatchObject({ recordFloors: [{ recordIndex: 1, floor: 1 }], pendingEdits: [{ recordIndex: 1, fields: ["w", "", "x"] }] });
    s.edit(0, 0, "q");
    s.edit(0, 2, "");
    expect(s.tryEdit(0, 1, "")).toMatchObject({ ok: true });
    await s.save();
    expect(text("/h/floor2.csv")).toBe("a,b,c\nq\nz,z,z\n");
  });

  it("the host never writes a record that would be one empty field, whatever the webview says, and the user is told", async () => {
    const s = await openSession("/h/vanish.csv", "n\nq\nz\n");
    const change = s.edit(0, 0, "w");
    s.undo();
    const loads = s.of("load").length;
    s.send({ type: "edit", baseVersion: s.baseVersion, change: { ...change, newValue: "" } } as any);
    expect(s.of("load").length).toBe(loads + 1);
    expect(s.of("editRefused")).toHaveLength(1);
    expect(s.messages.at(-1)).toMatchObject({ type: "editRefused" });
    expect(s.host.api.getDocument(s.key)).toMatchObject({ dirty: false, editCount: 0 });
    await s.save();
    expect(text("/h/vanish.csv")).toBe("n\nq\nz\n");
  });
});

describe("validation covers the whole record the host will write", () => {
  it("quotes off with a multi-character separator: an edit before a pending padded edit is checked against it", async () => {
    const s = await openSession("/h/qoff.csv", "a||b||c\nq\nr||s||t\n", { delimiter: "||", quotes: false, firstRowIsHeader: true });
    s.send({ type: "saveState", state: { ...s.of("load")[0].state, delimiter: "||", quotes: false } } as any);
    s.send({ type: "resync" } as any);
    s.edit(0, 2, "x");
    // "a|" followed by the padding separator would read back as "a" and "|x"
    expect(s.tryEdit(0, 0, "a|")).toMatchObject({ ok: false });
    expect(s.tryEdit(0, 0, "a")).toMatchObject({ ok: true });
    await s.save();
    expect(text("/h/qoff.csv")).toBe("a||b||c\na||||x\nr||s||t\n");
  });
});

describe("dirty is re-asserted after the webview confirms a save", () => {
  it("on `synced` for the new base, with no undo entry", async () => {
    const s = await openSession("/h/reassert.csv", "h,v\n1,a\n");
    s.edit(0, 1, "b");
    const entries = s.stack.length;
    fake.world.beforeWrite = () => {
      s.edit(0, 1, "c");
    };
    await s.save();
    fake.world.beforeWrite = undefined;
    // Nothing yet: the save reply is what clears VS Code's flag, so an event sent before it would be lost.
    expect(s.contentChanges).toBe(0);
    await tick(10);
    expect(s.contentChanges).toBe(1);
    expect(s.stack.length).toBe(entries + 1);
    expect(s.dirty).toBe(true);
  });

  it("after a delay when the webview never answers, and not at all if the document is clean by then", async () => {
    const s = await openSession("/h/reassert2.csv", "h,v\n1,a\n");
    s.autoSync = false;
    s.edit(0, 1, "b");
    fake.world.beforeWrite = () => {
      s.edit(0, 1, "c");
    };
    await s.save();
    fake.world.beforeWrite = undefined;
    await tick(100);
    expect(s.contentChanges).toBe(0);
    await tick(600);
    expect(s.contentChanges).toBe(1);

    const clean = await openSession("/h/reassert3.csv", "h,v\n1,a\n");
    clean.autoSync = false;
    clean.edit(0, 1, "b");
    fake.world.beforeWrite = () => {
      clean.edit(0, 1, "c");
    };
    await clean.save();
    fake.world.beforeWrite = undefined;
    clean.undo();
    expect(clean.dirty).toBe(false);
    await tick(600);
    expect(clean.contentChanges).toBe(0);
  });
});

describe("pinning the detected separator", () => {
  it("while the host holds edits is the same tokenization, not a format change", async () => {
    const s = await openSession("/h/pin.csv", "h,v\n1,a\n2,b\n");
    s.edit(0, 1, "A");
    const second = workerReply({ type: "editCell", rowId: 1, columnIndex: 1, value: "B" }, "editResult");
    const loads = s.of("load").length;
    s.send({ type: "saveState", state: { ...s.of("load")[0].state, delimiter: "," } } as any);
    s.send({ type: "edit", baseVersion: s.baseVersion, change: second.change } as any);
    expect(s.of("load").length).toBe(loads);
    expect(s.host.api.getDocument(s.key)).toMatchObject({ editCount: 2 });
    await s.save();
    expect(text("/h/pin.csv")).toBe("h,v\n1,A\n2,B\n");

    // A real change of separator while dirty is still refused.
    s.edit(0, 1, "C");
    s.send({ type: "saveState", state: { ...s.of("load")[0].state, delimiter: ";" } } as any);
    expect(s.of("load").length).toBe(loads + 1);
  });
});

describe("test hooks", () => {
  it("a moved viewer keeps the hooks: disposing the old panel does not remove the new one's", async () => {
    const s = await openSession("/h/hooks.csv", "h,v\n1,a\n");
    const api = s.host.api as any;
    const replacement = new Session(s.host, s.doc, s.path);
    await replacement.attach({});
    s.closePanel();
    expect(api.postToWebview(s.key, { type: "fileRestored" })).toBe(true);
    expect(replacement.of("fileRestored")).toHaveLength(1);
    expect(api.simulateWebviewMessage(s.key, { type: "resync" })).toBe(true);
  });
});
