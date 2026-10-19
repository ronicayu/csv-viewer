import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyTextPatches } from "../../core/csvEdit";
import { parseCsv } from "../../core/csvParse";
import { filterCacheKey, filterRowIds } from "../../core/filter";
import { buildColumnSortKeys, sortRowIdsByCachedKeys } from "../../core/sort";
import type { FilterRule, SortKey } from "../../core/types";
import { bootHost, callWorker, workerReply } from "./harness";

const OPTIONS = { firstRowIsHeader: true, quotes: true };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const CELLS = ["a", "B", "ab", "10", "2", "x y", "é", "", "A"];
const textArb = fc
  .tuple(fc.integer({ min: 2, max: 3 }), fc.array(fc.array(fc.constantFrom(...CELLS), { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 7 }))
  .map(([cols, rows]) => [Array.from({ length: cols }, (_, i) => `h${i}`), ...rows.map((r) => r.slice(0, cols))].map((r) => r.join(",")).join("\n") + "\n");

const ruleArb: fc.Arbitrary<FilterRule> = fc.record({
  id: fc.constantFrom("r1", "r2", "r3"),
  column: fc.constantFrom<string | null>("h0", "h1", "h2", null, "missing"),
  operator: fc.constantFrom<FilterRule["operator"]>("contains", "equals", "startsWith", "gt", "isEmpty", "regex", "in"),
  value: fc.constantFrom("a", "B", "1", "", "[", "^a"),
  values: fc.constantFrom<string[] | undefined>(undefined, [], ["a", "10"]),
  mode: fc.constantFrom<FilterRule["mode"]>("include", "exclude"),
  caseSensitive: fc.boolean(),
  enabled: fc.boolean(),
});

type Query = { quickSearch: string; rules: FilterRule[]; sort: SortKey[] };

const queryArb: fc.Arbitrary<Query> = fc.record({
  quickSearch: fc.constantFrom("", "a", "B", " 1 ", "é"),
  rules: fc.array(ruleArb, { maxLength: 2 }),
  sort: fc.array(fc.record({ column: fc.constantFrom("h0", "h1", "h2", "missing"), direction: fc.constantFrom<SortKey["direction"]>("asc", "desc") }), { maxLength: 2 }),
});

type Step =
  // `resort`: the previous search and rules again, with this query's sort.
  | { op: "query"; query: Query; resort: boolean }
  | { op: "edit"; rowId: number; column: number; value: string }
  | { op: "setCells"; cells: { rowId: number; columnIndex: number; value: string }[] }
  | { op: "rebase" }
  | { op: "reparse"; firstRowIsHeader: boolean }
  | { op: "init"; text: string; slice: number };

const valueArb = fc.constantFrom("a", "B", "zz", "", "x,y", "10", "é");
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.tuple(queryArb, fc.boolean()).map(([query, resort]): Step => ({ op: "query", query, resort })) },
  { weight: 3, arbitrary: fc.tuple(fc.nat({ max: 9 }), fc.nat({ max: 3 }), valueArb).map(([rowId, column, value]): Step => ({ op: "edit", rowId, column, value })) },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.tuple(fc.nat({ max: 9 }), fc.nat({ max: 3 }), valueArb), { minLength: 1, maxLength: 3 })
      .map((cells): Step => ({ op: "setCells", cells: cells.map(([rowId, columnIndex, value]) => ({ rowId, columnIndex, value })) })),
  },
  { weight: 1, arbitrary: fc.constant<Step>({ op: "rebase" }) },
  { weight: 1, arbitrary: fc.boolean().map((firstRowIsHeader): Step => ({ op: "reparse", firstRowIsHeader })) },
  { weight: 1, arbitrary: fc.tuple(textArb, fc.integer({ min: 1, max: 3 })).map(([text, slice]): Step => ({ op: "init", text, slice })) },
);

// The ids a query must produce, from a model of the rows that knows nothing about the worker's caches.
function expectedIds(headers: string[], rows: string[][], q: Query): number[] {
  const ids = filterRowIds(headers, rows, q.quickSearch, q.rules);
  const sortColumns = q.sort.flatMap((key) => {
    const ci = headers.indexOf(key.column);
    return ci === -1 ? [] : [{ direction: key.direction, keys: buildColumnSortKeys(rows, ci) }];
  });
  return sortRowIdsByCachedKeys(ids, sortColumns);
}

describe("worker: the filtered ids kept between queries", () => {
  it("every query returns what a fresh filter and sort of the current rows return, whatever came before it (property)", async () => {
    await bootHost();
    let hits = 0;
    let misses = 0;
    fc.assert(
      fc.property(textArb, fc.array(stepArb, { minLength: 1, maxLength: 14 }), (text0, steps) => {
        let headers: string[] = [];
        let rows: string[][] = [];
        let firstRowIsHeader = true;
        let source = text0;
        const load = (): void => {
          const parsed = parseCsv(source, { firstRowIsHeader, quotes: true });
          headers = parsed.headers;
          rows = parsed.rows.map((r) => r.slice());
        };
        callWorker({ type: "init", bytes: encode(source), options: OPTIONS });
        load();
        // Whether the worker may still hold the ids of `lastQuery`.
        let lastQuery: string | null = null;
        let lastQueryObject: Query | null = null;
        let valid = false;

        for (const step of steps) {
          switch (step.op) {
            case "query": {
              const query: Query = step.resort && lastQueryObject ? { ...lastQueryObject, sort: step.query.sort } : step.query;
              lastQueryObject = query;
              const { quickSearch, rules, sort } = query;
              const key = JSON.stringify([quickSearch, rules]);
              const reply = callWorker({ type: "query", quickSearch, filterRules: rules, sortKeys: sort }).find((m) => m.type === "queryResult")!;
              const page = workerReply({ type: "page", page: 1, pageSize: 1000 }, "pageResult").rows.map((r: { id: number }) => r.id);
              const expected = expectedIds(headers, rows, query);
              expect(page).toEqual(expected);
              expect(reply.filteredCount).toBe(expected.length);
              // Nothing stale is ever served, and an unchanged search with unchanged rows is served from the cache.
              if (!valid) expect(reply.filterCached).toBe(false);
              if (valid && key === lastQuery) expect(reply.filterCached).toBe(true);
              reply.filterCached ? hits++ : misses++;
              lastQuery = key;
              valid = true;
              break;
            }
            case "edit": {
              if (rows.length === 0) break;
              const rowId = step.rowId % rows.length;
              const column = step.column % headers.length;
              const result = workerReply({ type: "editCell", rowId, columnIndex: column, value: step.value }, "editResult");
              if (result.ok && result.change) {
                rows[rowId][column] = step.value;
                valid = false;
              }
              break;
            }
            case "setCells": {
              if (rows.length === 0) break;
              const cells = step.cells.map((c) => ({ rowId: c.rowId % rows.length, columnIndex: c.columnIndex % headers.length, value: c.value }));
              workerReply({ type: "setCells", cells }, "setCellsDone");
              for (const c of cells) rows[c.rowId][c.columnIndex] = c.value;
              valid = false;
              break;
            }
            case "rebase": {
              // The worker's text now holds the edits, which is what a re-parse reads; edits that were never rebased are not in it.
              source = applyTextPatches(source, workerReply({ type: "rebase" }, "rebased").patches);
              valid = false;
              break;
            }
            case "reparse": {
              firstRowIsHeader = step.firstRowIsHeader;
              callWorker({ type: "reparse", options: { firstRowIsHeader, quotes: true } });
              load();
              valid = false;
              break;
            }
            case "init": {
              source = step.text;
              callWorker({ type: "init", bytes: encode(source), options: { firstRowIsHeader, quotes: true }, tuning: { sliceRecords: step.slice } });
              load();
              valid = false;
              break;
            }
          }
        }
      }),
      { numRuns: 600 },
    );
    // The property is not vacuous: the cache was both used and refused.
    expect(hits).toBeGreaterThan(100);
    expect(misses).toBeGreaterThan(100);
  });

  it("a sort-only change after a filtered query does not filter again, and a changed rule does", async () => {
    await bootHost();
    callWorker({ type: "init", bytes: encode("n,v\n1,a\n2,b\n3,a\n"), options: OPTIONS });
    const rule: FilterRule = { id: "r", column: "v", operator: "equals", value: "a", mode: "include", caseSensitive: false, enabled: true };
    const ask = (rules: FilterRule[], sort: SortKey[]) => callWorker({ type: "query", quickSearch: "", filterRules: rules, sortKeys: sort }).find((m) => m.type === "queryResult")!;
    expect(ask([rule], []).filterCached).toBe(false);
    expect(ask([rule], [{ column: "n", direction: "desc" }])).toMatchObject({ filteredCount: 2, filterCached: true });
    expect(workerReply({ type: "page", page: 1, pageSize: 10 }, "pageResult").rows.map((r: { id: number }) => r.id)).toEqual([2, 0]);
    expect(ask([{ ...rule, value: "b" }], [])).toMatchObject({ filteredCount: 1, filterCached: false });
    // A rule that takes no part (disabled) is not part of the key.
    expect(ask([{ ...rule, value: "b" }, { ...rule, id: "off", enabled: false }], [])).toMatchObject({ filteredCount: 1, filterCached: true });
  });

  it("filterCacheKey ignores what filtering ignores and nothing else (property)", () => {
    const headers = ["h0", "h1", "h2"];
    fc.assert(
      fc.property(fc.constantFrom("", "a"), fc.array(ruleArb, { maxLength: 3 }), ruleArb, (quickSearch, rules, extra) => {
        const base = filterCacheKey(headers, quickSearch, rules);
        // An inert rule (disabled) and the ids of the rules never change the key.
        expect(filterCacheKey(headers, quickSearch, [...rules, { ...extra, enabled: false }])).toBe(base);
        expect(filterCacheKey(headers, quickSearch, rules.map((r) => ({ ...r, id: r.id + "x" })))).toBe(base);
      }),
      { numRuns: 500 },
    );
  });
});
