import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { defaultVisibility, detailFieldsFor, detailOnlyColumns, getVisibility, reconcileVisibility, visibleColumns } from "../../core/columns";

describe("header named 'constructor' — safe", () => {
  it("gets a real own property and round-trips through reconcileVisibility normally", () => {
    const headers = ["constructor", "name"];
    const vis = defaultVisibility(headers, 1);
    expect(vis.constructor).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(vis, "constructor")).toBe(true);
    expect(visibleColumns(headers, vis)).toEqual(["constructor"]);
    expect(detailOnlyColumns(headers, vis)).toEqual(["name"]);

    const reconciled = reconcileVisibility(headers, vis, 1);
    expect(reconciled).toEqual(vis);
  });
});

describe("header named 'hasOwnProperty' — safe (code explicitly guards this)", () => {
  it("round-trips because the code calls Object.prototype.hasOwnProperty.call, not map.hasOwnProperty", () => {
    const headers = ["hasOwnProperty", "name"];
    const vis = defaultVisibility(headers, 1);
    expect(vis.hasOwnProperty).toBe(true);
    const reconciled = reconcileVisibility(headers, vis, 0);
    expect(reconciled.hasOwnProperty).toBe(true);
  });
});

describe("header named '__proto__' — FIXED", () => {
  it("gets a real own entry in the returned map, for every defaultTableColumns setting", () => {
    const headers = ["__proto__", "name"];
    const vis = defaultVisibility(headers, 2);
    expect(Object.prototype.hasOwnProperty.call(vis, "__proto__")).toBe(true);
    expect(getVisibility(vis, "__proto__")).toBe(true);
  });

  it("is correctly detail-only when defaultTableColumns says so, not shown by accident", () => {
    const headers = ["__proto__", "name"];
    const vis = defaultVisibility(headers, 0);
    expect(detailOnlyColumns(headers, vis)).toEqual(["__proto__", "name"]);
  });

  it("keeps a previously-hidden '__proto__' column hidden after reconcileVisibility, when `previous` comes from a realistic source", () => {
    // Built with JSON.parse: a literal or bracket `__proto__` write sets the prototype, not an own property.
    const headers = ["__proto__", "name"];
    const previous = JSON.parse('{"name": true, "__proto__": false}') as Record<string, boolean>;
    expect(Object.prototype.hasOwnProperty.call(previous, "__proto__")).toBe(true);
    const reconciled = reconcileVisibility(headers, previous, 5);
    expect(getVisibility(reconciled, "__proto__")).toBe(false);
  });

  it("round-trips through JSON.stringify/JSON.parse (the real persistence path via workspaceState) without losing the '__proto__' entry", () => {
    const headers = ["__proto__", "other"];
    const vis = defaultVisibility(headers, 0);
    const roundTripped = JSON.parse(JSON.stringify(vis)) as Record<string, boolean>;
    expect(Object.prototype.hasOwnProperty.call(roundTripped, "__proto__")).toBe(true);
    expect(getVisibility(roundTripped, "__proto__")).toBe(false);

    const reconciled = reconcileVisibility(headers, roundTripped, 5);
    expect(getVisibility(reconciled, "__proto__")).toBe(false);
  });

  it("detailFieldsFor does not crash on a '__proto__' header (defensive smoke test)", () => {
    const headers = ["__proto__", "name"];
    const vis = defaultVisibility(headers, 1);
    expect(() => detailFieldsFor(headers, vis)).not.toThrow();
  });
});

describe("property: every ordinary (non-Object.prototype-colliding) header round-trips through defaultVisibility -> reconcileVisibility unchanged", () => {
  it("holds for random ASCII header sets that avoid known-dangerous names", () => {
    const dangerousNames = new Set(["__proto__"]);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !dangerousNames.has(s)), {
          minLength: 1,
          maxLength: 15,
        }),
        fc.nat({ max: 15 }),
        (headers, defaultTableColumns) => {
          const vis = defaultVisibility(headers, defaultTableColumns);
          const reconciled = reconcileVisibility(headers, vis, defaultTableColumns);
          expect(reconciled).toEqual(vis);
        },
      ),
      { numRuns: 200 },
    );
  });
});
