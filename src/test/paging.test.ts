import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, clampPage, normalizePageSize, pageCount, pageForRow, pageSlice } from "../core/paging";

describe("pageCount", () => {
  it("is 1 for an empty list", () => {
    expect(pageCount(0, 100)).toBe(1);
  });

  it("divides evenly on an exact multiple", () => {
    expect(pageCount(200, 100)).toBe(2);
    expect(pageCount(500, 500)).toBe(1);
  });

  it("rounds up for a last partial page", () => {
    expect(pageCount(250, 100)).toBe(3);
    expect(pageCount(1, 100)).toBe(1);
  });

  it("is never less than 1 for a degenerate size", () => {
    expect(pageCount(20_000, 0)).toBe(1);
    expect(pageCount(20_000, -5)).toBe(1);
  });
});

describe("clampPage", () => {
  it("clamps below range up to 1", () => {
    expect(clampPage(0, 250, 100)).toBe(1);
    expect(clampPage(-3, 250, 100)).toBe(1);
  });

  it("clamps above range down to the last page", () => {
    expect(clampPage(999, 250, 100)).toBe(3);
  });

  it("leaves an in-range page untouched", () => {
    expect(clampPage(2, 250, 100)).toBe(2);
  });

  it("clamps to 1 for an empty list regardless of requested page", () => {
    expect(clampPage(5, 0, 100)).toBe(1);
  });

  it("truncates a fractional or non-finite page", () => {
    expect(clampPage(2.9, 250, 100)).toBe(2);
    expect(clampPage(NaN, 250, 100)).toBe(1);
  });
});

describe("pageSlice", () => {
  it("returns an empty [0, 0) slice for an empty list", () => {
    expect(pageSlice(0, 1, 100)).toEqual({ start: 0, end: 0 });
  });

  it("slices exact multiples with no remainder", () => {
    expect(pageSlice(200, 1, 100)).toEqual({ start: 0, end: 100 });
    expect(pageSlice(200, 2, 100)).toEqual({ start: 100, end: 200 });
  });

  it("shortens the last partial page", () => {
    expect(pageSlice(250, 3, 100)).toEqual({ start: 200, end: 250 });
  });

  it("clamps an out-of-range page before slicing", () => {
    expect(pageSlice(250, 99, 100)).toEqual({ start: 200, end: 250 });
    expect(pageSlice(250, -1, 100)).toEqual({ start: 0, end: 100 });
  });
});

describe("pageForRow", () => {
  it("puts row 0 on page 1", () => {
    expect(pageForRow(0, 100)).toBe(1);
  });

  it("puts the last row of a page on that page, and the next row on the next page", () => {
    expect(pageForRow(99, 100)).toBe(1);
    expect(pageForRow(100, 100)).toBe(2);
  });

  it("handles a negative or invalid row index by returning page 1", () => {
    expect(pageForRow(-1, 100)).toBe(1);
    expect(pageForRow(NaN, 100)).toBe(1);
  });
});

describe("normalizePageSize", () => {
  it("accepts every listed page size", () => {
    for (const size of PAGE_SIZES) expect(normalizePageSize(size)).toBe(size);
  });

  it("falls back to the default for a missing value", () => {
    expect(normalizePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("falls back to the default for a value that isn't one of the allowed sizes", () => {
    expect(normalizePageSize(37)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(-100)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("falls back to the default for a non-numeric value (e.g. corrupted stored state)", () => {
    expect(normalizePageSize("100")).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(null)).toBe(DEFAULT_PAGE_SIZE);
  });
});
