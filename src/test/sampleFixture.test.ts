import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../core/csvParse";

describe("samples/people.csv", () => {
  const text = readFileSync(join(__dirname, "../../samples/people.csv"), "utf8");
  const result = parseCsv(text);

  it("parses the expected header and row shape", () => {
    expect(result.headers).toHaveLength(15);
    expect(result.rows).toHaveLength(40);
  });

  it("preserves embedded newlines inside quoted notes", () => {
    const notesIndex = result.headers.indexOf("notes");
    const multilineRow = result.rows.find((r) => r[notesIndex].includes("\n"));
    expect(multilineRow).toBeDefined();
    expect(multilineRow![notesIndex].split("\n").length).toBeGreaterThan(1);
  });

  it("preserves quoted commas inside fields", () => {
    const projectsIndex = result.headers.indexOf("projects");
    const quotedCommaRow = result.rows.find((r) => r[projectsIndex].startsWith('"Special'));
    expect(quotedCommaRow).toBeDefined();
    expect(quotedCommaRow![projectsIndex]).toContain(",");
  });

  it("has some empty cells", () => {
    const hasEmpty = result.rows.some((r) => r.some((cell) => cell === ""));
    expect(hasEmpty).toBe(true);
  });

  it("has numeric-looking cells in the salary column", () => {
    const salaryIndex = result.headers.indexOf("salary");
    const numericCells = result.rows.map((r) => r[salaryIndex]).filter((v) => v !== "" && Number.isFinite(Number(v)));
    expect(numericCells.length).toBeGreaterThan(30);
  });
});
