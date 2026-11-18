import { describe, expect, it } from "vitest";
import { applyModifiers, keywordRowsFor, resolveEnter } from "refr/lib/tag-input-pick";

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

describe("value keywords", () => {
  it("Enter keeps a complete value keyword literal instead of going semantic", () => {
    const r = resolveEnter({ raw: "w>2000", debounced: "w>2000", open: true, rows: [], highlight: 0, showSemantic: true, navigated: false });
    expect(r).toEqual({ kind: "literal", value: "w>2000" });
  });

  it("hint rows fill the input", () => {
    const r = resolveEnter({ raw: "add", debounced: "add", open: true, rows: [{ name: "added:" }], highlight: 0, showSemantic: false, navigated: false });
    expect(r).toEqual({ kind: "fill", prefix: "added:" });
  });
});

describe("keyword groups", () => {
  const kw = ["untagged", "type:image", "wallpaper:any", "wallpaper:16:9", "wallpaper:21:9"];

  it("collapses the namespace when nothing is typed", () => {
    expect(keywordRowsFor(kw, "")).toEqual({ groups: ["wallpaper:"], keywords: ["untagged", "type:image"] });
  });

  it("keeps the collapsed row while typing toward it", () => {
    expect(keywordRowsFor(kw, "wall")).toEqual({ groups: ["wallpaper:"], keywords: [] });
    expect(keywordRowsFor(kw, "wallpaper")).toEqual({ groups: ["wallpaper:"], keywords: [] });
  });

  it("lists members once the prefix is filled", () => {
    expect(keywordRowsFor(kw, "wallpaper:")).toEqual({ groups: [], keywords: ["wallpaper:any", "wallpaper:16:9", "wallpaper:21:9"] });
    expect(keywordRowsFor(kw, "wallpaper:21")).toEqual({ groups: [], keywords: ["wallpaper:21:9"] });
  });

  it("matches members directly on other typing", () => {
    expect(keywordRowsFor(kw, "16:9")).toEqual({ groups: [], keywords: ["wallpaper:16:9"] });
  });

  it("the collapsed row fills instead of committing", () => {
    const rows = [{ name: "wallpaper:" }];
    expect(resolveEnter({ raw: "wall", debounced: "wall", open: true, rows, highlight: 0, showSemantic: false, navigated: false }))
      .toEqual({ kind: "fill", prefix: "wallpaper:" });
  });
});
