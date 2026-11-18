import { describe, expect, it } from "vitest";
import { applyModifiers, resolveEnter } from "refr/lib/tag-input-pick";

const base = {
  open: true,
  highlight: 0,
  showSemantic: false,
  navigated: false,
};

describe("resolveEnter", () => {
  it("commits the literal input while the debounced rows are stale", () => {
    // typed "x" fast: rows still built for "" (path: fill row first)
    expect(resolveEnter({ ...base, raw: "x", debounced: "", rows: [{ name: "path:" }, { name: "untagged" }] }))
      .toEqual({ kind: "literal", value: "x" });
    expect(resolveEnter({ ...base, raw: "cats", debounced: "cat", rows: [{ name: "category" }] }))
      .toEqual({ kind: "literal", value: "cats" });
  });

  it("does nothing on a bare Enter in an empty box, unless a row was chosen", () => {
    const rows = [{ name: "path:" }, { name: "suggest:" }];
    expect(resolveEnter({ ...base, raw: "", debounced: "", rows })).toEqual({ kind: "none" });
    expect(resolveEnter({ ...base, raw: "", debounced: "", rows, navigated: true }))
      .toEqual({ kind: "fill", prefix: "path:" });
  });

  it("keeps a typed wildcard unless a row was explicitly chosen", () => {
    const rows = [{ name: "cat" }, { name: "car" }];
    expect(resolveEnter({ ...base, raw: "ca*", debounced: "ca*", rows })).toEqual({ kind: "literal", value: "ca*" });
    expect(resolveEnter({ ...base, raw: "ca*", debounced: "ca*", rows, highlight: 1, navigated: true }))
      .toEqual({ kind: "pick", name: "car" });
  });

  it("picks the highlighted row when fresh; modifiers re-attach", () => {
    const action = resolveEnter({ ...base, raw: "-cat", debounced: "cat", rows: [{ name: "category" }] });
    expect(action).toEqual({ kind: "pick", name: "category" });
    expect(applyModifiers("-cat", "category")).toBe("-category");
  });

  it("commits the literal input when the dropdown is closed", () => {
    expect(resolveEnter({ ...base, open: false, raw: " cat ", debounced: "cat", rows: [{ name: "category" }] }))
      .toEqual({ kind: "literal", value: "cat" });
    expect(resolveEnter({ ...base, open: false, raw: "", debounced: "", rows: [] })).toEqual({ kind: "none" });
  });

  it("selects the semantic fallback row", () => {
    expect(resolveEnter({ ...base, raw: "red car", debounced: "red car", rows: [], showSemantic: true }))
      .toEqual({ kind: "semantic" });
  });

  it("falls back to the literal input when there are no rows", () => {
    expect(resolveEnter({ ...base, raw: "newtag", debounced: "newtag", rows: [] }))
      .toEqual({ kind: "literal", value: "newtag" });
  });
});
