import { describe, expect, it } from "vitest";
import {
  type ColumnProfile,
  defaultVisibility,
  detailFieldsFor,
  detailOnlyColumns,
  getColumnFlag,
  getVisibility,
  isAutoMarkdownColumn,
  isNumericColumn,
  normalizeColumnFlags,
  profileColumns,
  reconcileVisibility,
  setColumnFlag,
  visibleColumns,
} from "../core/columns";

describe("defaultVisibility", () => {
  it("shows the first N columns and hides the rest", () => {
    const headers = ["a", "b", "c", "d"];
    const visibility = defaultVisibility(headers, 2);
    expect(visibility).toEqual({ a: true, b: true, c: false, d: false });
  });

  it("shows everything when N is at least the column count", () => {
    const headers = ["a", "b"];
    expect(defaultVisibility(headers, 8)).toEqual({ a: true, b: true });
  });
});

describe("reconcileVisibility", () => {
  it("keeps visibility for columns whose names still exist", () => {
    const previous = { a: false, b: true, c: false };
    const headers = ["a", "b", "c"];
    expect(reconcileVisibility(headers, previous, 8)).toEqual(previous);
  });

  it("applies the default rule to newly appeared columns", () => {
    const previous = { a: false };
    const headers = ["a", "b", "c"];
    expect(reconcileVisibility(headers, previous, 1)).toEqual({ a: false, b: false, c: false });
  });

  it("merges instead of dropping settings for columns that no longer exist, so a later round trip back to that name restores them — but visibleColumns/detailFieldsFor still only consider the current headers", () => {
    const previous = { a: true, removed: false };
    const headers = ["a"];
    const reconciled = reconcileVisibility(headers, previous, 8);
    expect(reconciled.a).toBe(true);
    expect(getVisibility(reconciled, "removed")).toBe(false);
    expect(visibleColumns(headers, reconciled)).toEqual(["a"]);
  });
});

describe("visibleColumns / detailOnlyColumns", () => {
  const headers = ["a", "b", "c"];
  const visibility = { a: true, b: false, c: true };

  it("visibleColumns returns columns not explicitly hidden", () => {
    expect(visibleColumns(headers, visibility)).toEqual(["a", "c"]);
  });

  it("detailOnlyColumns returns columns explicitly hidden", () => {
    expect(detailOnlyColumns(headers, visibility)).toEqual(["b"]);
  });
});

describe("detailFieldsFor", () => {
  it("returns the detail-only columns when some are hidden", () => {
    const headers = ["a", "b", "c"];
    const visibility = { a: true, b: false, c: true };
    expect(detailFieldsFor(headers, visibility)).toEqual(["b"]);
  });

  it("returns every column when nothing is hidden", () => {
    const headers = ["a", "b", "c"];
    const visibility = { a: true, b: true, c: true };
    expect(detailFieldsFor(headers, visibility)).toEqual(headers);
  });
});

describe("profileColumns", () => {
  it("medianLength is the median trimmed length of non-empty values", () => {
    const headers = ["a"];
    const rows = [["x"], ["  xxx  "], ["xxxxx"]];
    expect(profileColumns(headers, rows)[0].medianLength).toBe(3);
  });

  it("empty values are excluded from every share/median (an all-empty column profiles as short/non-numeric)", () => {
    const headers = ["a"];
    const rows = [[""], [""], [""]];
    const profile = profileColumns(headers, rows)[0];
    expect(profile).toEqual({ medianLength: 0, multilineShare: 0, jsonShare: 0, numericShare: 0, markdownShare: 0 });
  });

  it("multilineShare counts values containing a line break", () => {
    const headers = ["a"];
    const rows = [["one\ntwo"], ["no break"], ["also\nbroken"], ["fine"]];
    expect(profileColumns(headers, rows)[0].multilineShare).toBe(0.5);
  });

  it("jsonShare counts values that parse as a JSON object or array", () => {
    const headers = ["a"];
    const rows = [['{"a":1}'], ["[1,2,3]"], ["not json"], ["also not"]];
    expect(profileColumns(headers, rows)[0].jsonShare).toBe(0.5);
  });

  it("numericShare counts values that parse via parseNumber", () => {
    const headers = ["a"];
    const rows = [["1"], ["2.5"], ["abc"], ["-3"]];
    expect(profileColumns(headers, rows)[0].numericShare).toBe(0.75);
  });

  it("only samples the first sampleSize rows", () => {
    const headers = ["a"];
    const rows = [["x"], ["x"], [JSON.stringify({ big: true })]];
    expect(profileColumns(headers, rows, 2)[0].jsonShare).toBe(0);
  });

  it("markdownShare counts non-empty values that look like Markdown, ignoring empties", () => {
    const headers = ["a"];
    const rows = [["# Title\nbody"], ["plain text"], [""], ["[docs](https://example.com)"], ["more plain"]];
    expect(profileColumns(headers, rows)[0].markdownShare).toBe(0.5);
  });

  it("markdownShare is 0 for plain prose, numbers and JSON", () => {
    const headers = ["a"];
    const rows = [["just words"], ["42"], ['{"a":"# not markdown"}'], ["see item #1 or 1. maybe * here"]];
    expect(profileColumns(headers, rows)[0].markdownShare).toBe(0);
  });

  it("markdownShare only samples the first sampleSize rows", () => {
    const headers = ["a"];
    const rows = [["x"], ["x"], ["# heading"]];
    expect(profileColumns(headers, rows, 2)[0].markdownShare).toBe(0);
  });

  it("a ragged row (fewer cells than headers) contributes nothing for the missing column", () => {
    const headers = ["a", "b"];
    const rows = [["x"], ["x", "y"]];
    const profiles = profileColumns(headers, rows);
    expect(profiles[1].medianLength).toBe(1);
  });
});

describe("isNumericColumn", () => {
  it("true at or above the 90% numeric threshold", () => {
    const profile: ColumnProfile = { medianLength: 2, multilineShare: 0, jsonShare: 0, numericShare: 0.9, markdownShare: 0 };
    expect(isNumericColumn(profile)).toBe(true);
  });

  it("false below the threshold", () => {
    const profile: ColumnProfile = { medianLength: 2, multilineShare: 0, jsonShare: 0, numericShare: 0.89, markdownShare: 0 };
    expect(isNumericColumn(profile)).toBe(false);
  });

  it("false for an undefined profile", () => {
    expect(isNumericColumn(undefined)).toBe(false);
  });
});

describe("isAutoMarkdownColumn", () => {
  it("true at or above the 10% threshold, false below", () => {
    const base: ColumnProfile = { medianLength: 5, multilineShare: 0, jsonShare: 0, numericShare: 0, markdownShare: 0.1 };
    expect(isAutoMarkdownColumn(base)).toBe(true);
    expect(isAutoMarkdownColumn({ ...base, markdownShare: 0.09 })).toBe(false);
  });

  it("false for an undefined profile", () => {
    expect(isAutoMarkdownColumn(undefined)).toBe(false);
  });
});

describe("column flag maps (markdownColumns)", () => {
  it("round-trips __proto__ and constructor as ordinary column names", () => {
    const map = {};
    setColumnFlag(map, "__proto__", true);
    setColumnFlag(map, "constructor", false);
    expect(getColumnFlag(map, "__proto__")).toBe(true);
    expect(getColumnFlag(map, "constructor")).toBe(false);
    expect(getColumnFlag(map, "toString")).toBeUndefined();
    expect(getColumnFlag(map, "other")).toBeUndefined();
    const restored = normalizeColumnFlags(JSON.parse(JSON.stringify(map)));
    expect(getColumnFlag(restored, "__proto__")).toBe(true);
    expect(getColumnFlag(restored, "constructor")).toBe(false);
  });

  it("normalizeColumnFlags returns {} for missing or malformed input and drops non-boolean entries", () => {
    expect(normalizeColumnFlags(undefined)).toEqual({});
    expect(normalizeColumnFlags(null)).toEqual({});
    expect(normalizeColumnFlags([true])).toEqual({});
    expect(normalizeColumnFlags("x")).toEqual({});
    expect(normalizeColumnFlags({ a: true, b: "yes", c: false })).toEqual({ a: true, c: false });
  });
});

function profile(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return { medianLength: 10, multilineShare: 0, jsonShare: 0, numericShare: 0, markdownShare: 0, ...overrides };
}

describe("reconcileVisibility with profiles", () => {
  it("without profiles, behaves exactly like the old positional rule (back-compat for existing callers/tests)", () => {
    const headers = ["a", "b", "c", "d"];
    expect(reconcileVisibility(headers, {}, 2)).toEqual({ a: true, b: true, c: false, d: false });
  });

  it("a file whose columns are all short matches today's first-N exactly", () => {
    const headers = ["a", "b", "c", "d"];
    const profiles = headers.map(() => profile());
    expect(reconcileVisibility(headers, {}, 2, profiles)).toEqual({ a: true, b: true, c: false, d: false });
  });

  it("median length over 60 makes a column not-short", () => {
    const headers = ["short", "long"];
    const profiles = [profile(), profile({ medianLength: 61 })];
    expect(reconcileVisibility(headers, {}, 8, profiles)).toEqual({ short: true, long: false });
  });

  it("multiline share >= 10% makes a column not-short", () => {
    const headers = ["short", "multiline"];
    const profiles = [profile(), profile({ multilineShare: 0.1 })];
    expect(reconcileVisibility(headers, {}, 8, profiles)).toEqual({ short: true, multiline: false });
  });

  it("just under the 10% multiline threshold still counts as short", () => {
    const headers = ["short", "almost"];
    const profiles = [profile(), profile({ multilineShare: 0.09 })];
    expect(reconcileVisibility(headers, {}, 8, profiles)).toEqual({ short: true, almost: true });
  });

  it("json share >= 50% makes a column not-short", () => {
    const headers = ["short", "json"];
    const profiles = [profile(), profile({ jsonShare: 0.5 })];
    expect(reconcileVisibility(headers, {}, 8, profiles)).toEqual({ short: true, json: false });
  });

  it("long/multiline/json columns are skipped in favor of later short columns, up to the cap", () => {
    const headers = ["json_col", "notes", "id", "description", "status"];
    const profiles = [
      profile({ jsonShare: 1 }),
      profile({ medianLength: 2000 }),
      profile(),
      profile({ multilineShare: 1 }),
      profile(),
    ];
    expect(reconcileVisibility(headers, {}, 8, profiles)).toEqual({
      json_col: false,
      notes: false,
      id: true,
      description: false,
      status: true,
    });
  });

  it("stops adding short columns once the cap is reached, even if more short columns follow", () => {
    const headers = ["a", "b", "c"];
    const profiles = headers.map(() => profile());
    expect(reconcileVisibility(headers, {}, 2, profiles)).toEqual({ a: true, b: true, c: false });
  });

  it("a cap of 0 means no columns in the table, even on an all-short file", () => {
    const headers = ["a", "b"];
    const profiles = headers.map(() => profile());
    expect(reconcileVisibility(headers, {}, 0, profiles)).toEqual({ a: false, b: false });
  });

  it("guarantees at least one column (the first) when no column is short and the cap is non-zero", () => {
    const headers = ["long_a", "long_b", "long_c"];
    const profiles = headers.map(() => profile({ medianLength: 500 }));
    expect(reconcileVisibility(headers, {}, 8, profiles)).toEqual({ long_a: true, long_b: false, long_c: false });
  });

  it("a stored per-file choice always wins over the profile, in either direction", () => {
    const headers = ["notes", "id"];
    const previous = { notes: true, id: false };
    const profiles = [profile({ medianLength: 2000 }), profile()];
    expect(reconcileVisibility(headers, previous, 8, profiles)).toEqual({ notes: true, id: false });
  });

  it("stored-visible columns count against the cap for new short columns", () => {
    const headers = ["stored", "a", "b"];
    const previous = { stored: true };
    const profiles = [profile(), profile(), profile()];
    expect(reconcileVisibility(headers, previous, 2, profiles)).toEqual({ stored: true, a: true, b: false });
  });

  it("the fresh-file guarantee does not apply once any current header has a stored choice (e.g. 'hide all')", () => {
    const headers = ["a", "b"];
    const previous = { a: false, b: false };
    const profiles = [profile({ medianLength: 500 }), profile({ medianLength: 500 })];
    expect(reconcileVisibility(headers, previous, 8, profiles)).toEqual({ a: false, b: false });
  });

  it("survives a header-toggle round trip: a stored choice for a name absent from an intermediate header set is retained and reapplied once that name comes back", () => {
    const headers1 = ["id", "notes"];
    const previous = { id: true, notes: false };
    const syntheticHeaders = ["column_1", "column_2"];
    const syntheticProfiles = [profile(), profile()];
    const afterToggleOff = reconcileVisibility(syntheticHeaders, previous, 8, syntheticProfiles);
    expect(getVisibility(afterToggleOff, "id")).toBe(true);
    expect(getVisibility(afterToggleOff, "notes")).toBe(false);

    const afterToggleOn = reconcileVisibility(headers1, afterToggleOff, 8, [profile(), profile()]);
    expect(visibleColumns(headers1, afterToggleOn)).toEqual(["id"]);
  });

  it("is __proto__-safe as both a header name and a previous-map key", () => {
    const headers = ["__proto__", "id"];
    const profiles = [profile(), profile()];
    const result = reconcileVisibility(headers, {}, 8, profiles);
    expect(getVisibility(result, "__proto__")).toBe(true);
    expect(visibleColumns(headers, result)).toEqual(["__proto__", "id"]);

    const previous = reconcileVisibility(headers, {}, 1, profiles);
    const again = reconcileVisibility(headers, previous, 1, profiles);
    expect(getVisibility(again, "__proto__")).toBe(true);
    expect(getVisibility(again, "id")).toBe(false);
  });
});
