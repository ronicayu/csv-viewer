// Adversarial tests for src/core/columns.ts, focused on header names that
// collide with Object.prototype members. ColumnVisibilityMap is a plain
// object keyed by header name (`map[h] = ...`), which is generally safe
// because the code reads it back via Object.prototype.hasOwnProperty.call
// (defends against a header literally named "hasOwnProperty") — but one
// name breaks the whole scheme via a different mechanism.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { defaultVisibility, detailFieldsFor, detailOnlyColumns, getVisibility, reconcileVisibility, visibleColumns } from "../../core/columns";

describe("header named 'constructor' — safe", () => {
  it("gets a real own property and round-trips through reconcileVisibility normally", () => {
    const headers = ["constructor", "name"];
    const vis = defaultVisibility(headers, 1); // only first column ("constructor") in table
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
    expect(vis.hasOwnProperty).toBe(true); // shadows the inherited method with the boolean `true`
    const reconciled = reconcileVisibility(headers, vis, 0); // default would now hide it, but previous value must win
    expect(reconciled.hasOwnProperty).toBe(true);
  });
});

describe("header named '__proto__' — FIXED", () => {
  // FIXED: defaultVisibility/reconcileVisibility (src/core/columns.ts) now
  // write every entry via Object.defineProperty (which bypasses
  // Object.prototype's __proto__ accessor and always creates a real own
  // data property, even for "__proto__") and read only via
  // Object.prototype.hasOwnProperty.call + the getVisibility helper.
  it("gets a real own entry in the returned map, for every defaultTableColumns setting", () => {
    const headers = ["__proto__", "name"];
    const vis = defaultVisibility(headers, 2); // both columns should be in the table
    expect(Object.prototype.hasOwnProperty.call(vis, "__proto__")).toBe(true);
    expect(getVisibility(vis, "__proto__")).toBe(true);
  });

  it("is correctly detail-only when defaultTableColumns says so, not shown by accident", () => {
    const headers = ["__proto__", "name"];
    const vis = defaultVisibility(headers, 0); // BOTH columns should be detail-only
    expect(detailOnlyColumns(headers, vis)).toEqual(["__proto__", "name"]);
  });

  it("keeps a previously-hidden '__proto__' column hidden after reconcileVisibility, when `previous` comes from a realistic source", () => {
    // NOTE: the original version of this test built `previous` via
    // `(previous as any).__proto__ = false` — a runtime bracket
    // assignment on an ordinary object, which is exactly the no-op trap
    // this bug is about and can never create a real own property,
    // regardless of whether reconcileVisibility itself is fixed. The
    // realistic source, per the task's own framing ("persisted state is
    // JSON in VS Code workspaceState"), is JSON.parse, which — unlike a
    // literal/bracket write — does create a genuine own "__proto__"
    // property (per the JSON spec's use of CreateDataProperty).
    const headers = ["__proto__", "name"];
    const previous = JSON.parse('{"name": true, "__proto__": false}') as Record<string, boolean>;
    expect(Object.prototype.hasOwnProperty.call(previous, "__proto__")).toBe(true); // sanity: JSON.parse really does create an own property
    const reconciled = reconcileVisibility(headers, previous, 5); // default would show it (i < 5)
    expect(getVisibility(reconciled, "__proto__")).toBe(false);
  });

  it("round-trips through JSON.stringify/JSON.parse (the real persistence path via workspaceState) without losing the '__proto__' entry", () => {
    const headers = ["__proto__", "other"];
    const vis = defaultVisibility(headers, 0); // both detail-only
    const roundTripped = JSON.parse(JSON.stringify(vis)) as Record<string, boolean>;
    expect(Object.prototype.hasOwnProperty.call(roundTripped, "__proto__")).toBe(true);
    expect(getVisibility(roundTripped, "__proto__")).toBe(false);

    // And the round-tripped map still works correctly as `previous` input
    // to reconcileVisibility on the next load.
    const reconciled = reconcileVisibility(headers, roundTripped, 5); // default would show it now
    expect(getVisibility(reconciled, "__proto__")).toBe(false); // prior choice honored, not reset to default
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
