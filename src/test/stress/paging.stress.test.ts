// Adversarial/property tests for src/core/paging.ts.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  clampPage,
  normalizePageSize,
  pageCount,
  pageForRow,
  pageSlice,
} from "../../core/paging";

const validSize = fc.constantFrom(...PAGE_SIZES);

describe("property: pages tile the row list exactly (no gaps, no overlaps)", () => {
  it("the union of pageSlice(total, p, size) for p = 1..pageCount is exactly [0, total) with adjacent slices touching and none overlapping", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), validSize, (total, size) => {
        const count = pageCount(total, size);
        let expectedStart = 0;
        for (let p = 1; p <= count; p++) {
          const { start, end } = pageSlice(total, p, size);
          expect(start).toBe(expectedStart); // no gap since the last page
          expect(end).toBeGreaterThanOrEqual(start); // never inverted
          expectedStart = end;
        }
        // The last page's end covers every row.
        expect(expectedStart).toBe(Math.max(total, 0) === 0 ? 0 : total);
      }),
      { numRuns: 500 },
    );
  });
});

describe("property: clampPage is idempotent", () => {
  it("clamping an already-clamped page returns the same page", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), validSize, (page, total, size) => {
        const once = clampPage(page, total, size);
        const twice = clampPage(once, total, size);
        expect(twice).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("handles non-finite and fractional pages without throwing, still idempotent", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity), fc.double()),
        fc.integer({ min: 0, max: 100_000 }),
        validSize,
        (page, total, size) => {
          const once = clampPage(page, total, size);
          expect(Number.isFinite(once)).toBe(true);
          expect(clampPage(once, total, size)).toBe(once);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("property: pageForRow is consistent with pageSlice", () => {
  it("for any row index within [0, total), the page pageForRow reports actually contains that row in its pageSlice", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), validSize, (total, size) => {
        fc.assert(
          fc.property(fc.integer({ min: 0, max: total - 1 }), (rowIndex) => {
            const page = pageForRow(rowIndex, size);
            const { start, end } = pageSlice(total, page, size);
            expect(rowIndex).toBeGreaterThanOrEqual(start);
            expect(rowIndex).toBeLessThan(end);
          }),
          { numRuns: 50 },
        );
      }),
      { numRuns: 100 },
    );
  });
});

describe("normalizePageSize: adversarial inputs", () => {
  it("strings never pass through, even numeric-looking or exact-match ones", () => {
    expect(normalizePageSize("100")).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize("")).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize("25")).toBe(DEFAULT_PAGE_SIZE);
  });

  it("floats that happen to equal a valid size pass (100.0 === 100), floats that don't, fall back", () => {
    expect(normalizePageSize(100.0)).toBe(100);
    expect(normalizePageSize(100.5)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("negative sizes always fall back", () => {
    expect(normalizePageSize(-25)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(-100)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("NaN falls back (NaN !== NaN, so Array.includes correctly rejects it, but worth pinning down)", () => {
    expect(normalizePageSize(NaN)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("huge numbers fall back rather than being accepted or throwing", () => {
    expect(normalizePageSize(1e308)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(Number.MAX_SAFE_INTEGER)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(Infinity)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("property: the result is always one of PAGE_SIZES, for arbitrary input of any type", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = normalizePageSize(value);
        expect((PAGE_SIZES as readonly number[]).includes(result)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("pageCount / clampPage / pageSlice: extreme totals", () => {
  it("a huge total (500k rows) at the smallest page size produces the expected page count and every slice still tiles correctly at the boundary", () => {
    const total = 500_000;
    const size = 25;
    const count = pageCount(total, size);
    expect(count).toBe(20_000);
    expect(pageSlice(total, count, size)).toEqual({ start: 499_975, end: 500_000 });
    expect(pageSlice(total, 1, size)).toEqual({ start: 0, end: 25 });
  });

  it("total = Infinity or NaN degrades to a single page rather than throwing or looping", () => {
    expect(pageCount(Infinity, 100)).toBe(1);
    expect(pageCount(NaN, 100)).toBe(1);
    expect(clampPage(5, Infinity, 100)).toBe(1);
  });
});
