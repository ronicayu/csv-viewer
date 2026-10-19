import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fieldsForWrite, isRecordEdited, rebaseSpanTable, rebaseSpans, spliceByteReplacements, spliceBytes, spliceText } from "../core/csvEdit";
import { parseCsv } from "../core/csvParse";
import { addByteOffsets, spansFromTable, splitRecords, splitRecordsToTable, type SplitOptions } from "../core/recordSpans";

const OPTIONS: SplitOptions = { delimiter: ",", quotes: true };

function fieldsOf(text: string, index: number, options: SplitOptions = OPTIONS): string[] {
  const spans = splitRecords(text, options);
  return parseCsv(text.slice(spans[index].start, spans[index].end + spans[index].eol.length), {
    delimiter: options.delimiter,
    quotes: options.quotes,
    firstRowIsHeader: false,
  }).rows[0];
}

function edit(text: string, index: number, column: number, value: string, options: SplitOptions = OPTIONS): string {
  const spans = splitRecords(text, options);
  const fields = fieldsOf(text, index, options).slice();
  while (fields.length <= column) fields.push("");
  fields[column] = value;
  return spliceText(text, spans, [{ index, fields: fieldsForWrite(fields, spans[index].fieldCount) }], options.delimiter, options.quotes);
}

describe("spliceText", () => {
  it("is the identity with no edits", () => {
    const text = "﻿a,b\r\n\r\n1,2\n  \n3";
    expect(spliceText(text, splitRecords(text, OPTIONS), [], ",", true)).toBe(text);
  });

  it("rewrites only the edited record and keeps its own terminator and its neighbours' (CRLF next to LF)", () => {
    const text = "a,b\r\n1,2\r\n3,4\n5,6\n";
    expect(edit(text, 1, 1, "x")).toBe("a,b\r\n1,x\r\n3,4\n5,6\n");
    expect(edit(text, 2, 0, "y")).toBe("a,b\r\n1,2\r\ny,4\n5,6\n");
  });

  it("keeps blank lines, whitespace-only lines, the BOM and a missing final newline", () => {
    const text = "﻿a,b\n\n1,2\n   \n3,4";
    expect(edit(text, 3, 1, "x")).toBe("﻿a,b\n\n1,2\n   \n3,x");
  });

  it("re-serializes the whole edited record: redundant quotes on its other fields disappear", () => {
    expect(edit('a,b\n"a",b\n', 1, 1, "c")).toBe("a,b\na,c\n");
  });

  it("quotes only where needed and doubles quotes", () => {
    expect(edit("a,b\n1,2\n", 1, 0, 'x,"y"')).toBe('a,b\n"x,""y""",2\n');
  });

  it("writes an embedded CRLF of an edited record as LF", () => {
    expect(edit('a,b\n"p\r\nq",2\n', 1, 1, "z")).toBe('a,b\n"p\nq",z\n');
  });

  it("extends a short row only as far as the edited cell (padded cell)", () => {
    expect(edit("a,b,c\n1,2\n", 1, 2, "x")).toBe("a,b,c\n1,2,x\n");
    expect(edit("a,b,c\n1\n", 1, 1, "x")).toBe("a,b,c\n1,x\n");
  });

  it("edits two records and two cells of one record", () => {
    const text = "a,b,c\n1,2,3\n4,5,6\n";
    const spans = splitRecords(text, OPTIONS);
    expect(
      spliceText(
        text,
        spans,
        [
          { index: 1, fields: ["x", "2", "y"] },
          { index: 2, fields: ["4", "z", "6"] },
        ],
        ",",
        true,
      ),
    ).toBe("a,b,c\nx,2,y\n4,z,6\n");
  });

  it("an edit back to the baseline produces the input again", () => {
    const text = "a,b\n1,2\n3,4\n";
    expect(edit(edit(text, 1, 0, "zzz"), 1, 0, "1")).toBe(text);
  });

  it("handles the last record without a trailing newline", () => {
    expect(edit("a,b\n1,2", 1, 1, "x")).toBe("a,b\n1,x");
  });

  it("throws on overlapping, unsorted or out-of-range records", () => {
    const text = "a\nb\nc\n";
    const spans = splitRecords(text, OPTIONS);
    expect(() => spliceText(text, spans, [{ index: 1, fields: ["x"] }, { index: 0, fields: ["y"] }], ",", true)).toThrow();
    expect(() => spliceText(text, spans, [{ index: 1, fields: ["x"] }, { index: 1, fields: ["y"] }], ",", true)).toThrow();
    expect(() => spliceText(text, spans, [{ index: 9, fields: ["x"] }], ",", true)).toThrow();
  });
});

describe("isRecordEdited / fieldsForWrite", () => {
  it("ignores trailing empties beyond the original field count", () => {
    expect(isRecordEdited(["a"], ["a", "", ""])).toBe(false);
    expect(isRecordEdited(["a"], ["a", "", "x"])).toBe(true);
    expect(isRecordEdited(["a", "b"], ["a", ""])).toBe(true);
    expect(isRecordEdited(["a", ""], ["a", ""])).toBe(false);
  });

  it("keeps empties within the original count", () => {
    expect(fieldsForWrite(["a", "", ""], 3)).toEqual(["a", "", ""]);
    expect(fieldsForWrite(["a", "x", ""], 2)).toEqual(["a", "x"]);
  });
});

describe("spliceBytes", () => {
  it("equals the encoded spliceText, including BOM and multi-byte characters before the record", () => {
    const text = "﻿é,€\n😀,b\r\nc,d";
    const spans = splitRecords(text, OPTIONS);
    const table = splitRecordsToTable(text, OPTIONS);
    addByteOffsets(table, text);
    const fields = ["😀", "xé"];
    const viaText = new TextEncoder().encode(spliceText(text, spans, [{ index: 1, fields }], ",", true));
    const viaBytes = spliceBytes(
      new TextEncoder().encode(text),
      [{ byteStart: table.byteStart![1], byteEnd: table.byteEnd![1], fields }],
      ",",
      true,
    );
    expect(Array.from(viaBytes)).toEqual(Array.from(viaText));
  });

  it("throws on overlapping, unsorted or out-of-bounds records instead of writing a partial result", () => {
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    const r = (byteStart: number, byteEnd: number) => ({ byteStart, byteEnd, fields: ["x"] });
    expect(() => spliceBytes(bytes, [r(4, 7), r(0, 3)], ",", true)).toThrow();
    expect(() => spliceBytes(bytes, [r(0, 5), r(4, 7)], ",", true)).toThrow();
    expect(() => spliceBytes(bytes, [r(4, 99)], ",", true)).toThrow();
  });
});

describe("rebaseSpans (object spans)", () => {
  it("returns the char and byte spans of the spliced text", () => {
    const text = "a,b\r\né,2\n3,4";
    const table = splitRecordsToTable(text, OPTIONS);
    addByteOffsets(table, text);
    const spans = splitRecords(text, OPTIONS);
    const byteSpans = Array.from({ length: table.length }, (_, i) => ({ byteStart: table.byteStart![i], byteEnd: table.byteEnd![i] }));
    const records = [{ index: 1, fields: ["€€€", "x"] }];
    const rebased = rebaseSpans(spans, byteSpans, records, ",", true);
    const spliced = spliceText(text, spans, records, ",", true);
    const resplit = splitRecordsToTable(spliced, OPTIONS);
    addByteOffsets(resplit, spliced);
    expect(rebased.spans).toEqual(splitRecords(spliced, OPTIONS));
    expect(rebased.byteSpans).toEqual(Array.from({ length: resplit.length }, (_, i) => ({ byteStart: resplit.byteStart![i], byteEnd: resplit.byteEnd![i] })));
  });
});

describe("rebaseSpanTable", () => {
  it("matches re-splitting the spliced text, char and byte offsets", () => {
    const text = "a,b\r\n1,2\n\n3,4\n5,6";
    const table = splitRecordsToTable(text, OPTIONS);
    addByteOffsets(table, text);
    const records = [
      { index: 1, fields: ["longer value", "é"] },
      { index: 3, fields: ["5"] },
    ];
    const spliced = spliceText(text, table, records, ",", true);
    const rebased = rebaseSpanTable(table, records, ",", true);
    const resplit = splitRecordsToTable(spliced, OPTIONS);
    addByteOffsets(resplit, spliced);
    expect(spansFromTable(rebased)).toEqual(spansFromTable(resplit));
    expect(Array.from(rebased.byteStart!)).toEqual(Array.from(resplit.byteStart!));
    expect(Array.from(rebased.byteEnd!)).toEqual(Array.from(resplit.byteEnd!));
  });
});

const ALPHABET = ["a", "b", "1", ",", ";", '"', " ", "\n", "\r", "é", "😀", "\t"];
const textArb = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 50 }).map((c) => c.join(""));
const valueArb = fc
  .array(fc.constantFrom("a", "x", ",", ";", '"', " ", "\n", "é", "😀"), { maxLength: 6 })
  .map((c) => c.join(""));

describe("edit properties", () => {
  const scenario = fc.record({
    text: textArb,
    delimiter: fc.constantFrom(",", ";", "\t"),
    firstRowIsHeader: fc.boolean(),
    pick: fc.nat(),
    column: fc.nat({ max: 5 }),
    value: valueArb,
  });

  it("one edited cell changes only that cell: prefix and suffix identical, parse equal except the cell (locality)", () => {
    fc.assert(
      fc.property(scenario, ({ text, delimiter, firstRowIsHeader, pick, column, value }) => {
        const before = parseCsv(text, { delimiter, firstRowIsHeader });
        if (before.rows.length === 0 || before.headers.length === 0) return;
        const options: SplitOptions = { delimiter: before.delimiter, quotes: before.quoting };
        const spans = splitRecords(text, options);
        const rowId = pick % before.rows.length;
        const column2 = column % before.headers.length;
        const index = rowId + (firstRowIsHeader ? 1 : 0);
        const original = fieldsOf(text, index, options);
        const fields = original.slice();
        while (fields.length <= column2) fields.push("");
        fields[column2] = value.replace(/\r/g, "");
        // A lone empty field is a blank line, which no parser reads back as a row; the worker refuses that edit.
        const written = fieldsForWrite(fields, spans[index].fieldCount);
        if (written.length === 1 && written[0] === "") return;
        const out = spliceText(text, spans, [{ index, fields: written }], options.delimiter, options.quotes);

        expect(out.slice(0, spans[index].start)).toBe(text.slice(0, spans[index].start));
        expect(out.endsWith(text.slice(spans[index].end))).toBe(true);

        const after = parseCsv(out, { delimiter: options.delimiter, firstRowIsHeader, quotes: before.quoting });
        const expected = before.rows.map((r) => r.slice());
        expected[rowId][column2] = value.replace(/\r/g, "");
        expect(after.headers).toEqual(before.headers);
        expect(after.rows).toEqual(expected);
      }),
      { numRuns: 4000 },
    );
  });

  it("spliceBytes(encode(text)) equals encode(spliceText(text)), and rebaseSpans equals re-splitting (property)", () => {
    fc.assert(
      fc.property(textArb, fc.array(fc.tuple(fc.nat(), valueArb), { maxLength: 3 }), (text, picks) => {
        const table = splitRecordsToTable(text, OPTIONS);
        if (table.length === 0) return;
        addByteOffsets(table, text);
        const indexes = [...new Set(picks.map(([p]) => p % table.length))].sort((a, b) => a - b);
        const records = indexes.map((index, i) => ({ index, fields: ["k" + picks[i][1].replace(/\r/g, ""), "é"] }));
        const spliced = spliceText(text, table, records, ",", true);
        const bytes = spliceBytes(
          new TextEncoder().encode(text),
          records.map((r) => ({ byteStart: table.byteStart![r.index], byteEnd: table.byteEnd![r.index], fields: r.fields })),
          ",",
          true,
        );
        expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(spliced)));

        const rebased = rebaseSpanTable(table, records, ",", true);
        const resplit = splitRecordsToTable(spliced, OPTIONS);
        addByteOffsets(resplit, spliced);
        expect(spansFromTable(rebased)).toEqual(spansFromTable(resplit));
        expect(Array.from(rebased.byteStart!)).toEqual(Array.from(resplit.byteStart!));
        expect(Array.from(rebased.byteEnd!)).toEqual(Array.from(resplit.byteEnd!));
      }),
      { numRuns: 3000 },
    );
  });
});

describe("spliceByteReplacements", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("replaces byte ranges and keeps every other byte", () => {
    const out = spliceByteReplacements(enc("a,b\n1,2\n3,4\n"), [
      { byteStart: 4, byteEnd: 7, bytes: enc("é,€") },
      { byteStart: 8, byteEnd: 11, bytes: enc("") },
    ]);
    expect(new TextDecoder().decode(out)).toBe("a,b\né,€\n\n");
  });

  it("does nothing without replacements, and refuses overlapping or out-of-range ones", () => {
    const bytes = enc("abc");
    expect(Array.from(spliceByteReplacements(bytes, []))).toEqual(Array.from(bytes));
    expect(() => spliceByteReplacements(bytes, [{ byteStart: 1, byteEnd: 2, bytes: enc("x") }, { byteStart: 1, byteEnd: 3, bytes: enc("y") }])).toThrow();
    expect(() => spliceByteReplacements(bytes, [{ byteStart: 2, byteEnd: 9, bytes: enc("x") }])).toThrow();
  });
});
