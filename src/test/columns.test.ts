import { describe, expect, it } from "vitest";
import { defaultVisibility, detailFieldsFor, detailOnlyColumns, reconcileVisibility, visibleColumns } from "../core/columns";

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
    // defaultTableColumns=1: only the first column defaults to visible.
    expect(reconcileVisibility(headers, previous, 1)).toEqual({ a: false, b: false, c: false });
  });

  it("drops settings for columns that no longer exist", () => {
    const previous = { a: true, removed: false };
    const headers = ["a"];
    expect(reconcileVisibility(headers, previous, 8)).toEqual({ a: true });
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
