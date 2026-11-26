import { describe, expect, it } from "vitest";
import { applyModifiers, defaultHighlight, keywordRowsFor, resolveEnter } from "refr/lib/tag-input-pick";
import { matchRank } from "refr/lib/match";

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

describe("default highlight (match-aware)", () => {
  it("never auto-picks a mid-word substring: Enter keeps a new tag as typed", () => {
    const rows = [{ name: "tired" }];
    const h = defaultHighlight({ rows, typed: "red", pending: false, showSemantic: false });
    expect(h).toBe(-1);
    expect(resolveEnter({ ...base, raw: "red", debounced: "red", rows, highlight: h }))
      .toEqual({ kind: "literal", value: "red" });
    expect(defaultHighlight({ rows: [{ name: "untagged" }, { name: "tagged" }], typed: "tag", pending: false, showSemantic: false }))
      .toBe(1);
  });

  it("highlights exact, then prefix or segment-start matches", () => {
    const rows = [{ name: "scarf" }, { name: "cart" }, { name: "car" }];
    expect(defaultHighlight({ rows, typed: "car", pending: false, showSemantic: false })).toBe(2);
    expect(defaultHighlight({ rows: [{ name: "scarf" }, { name: "vehicle/car-red" }], typed: "car", pending: false, showSemantic: false })).toBe(1);
    expect(defaultHighlight({ rows: [{ name: "type:image" }], typed: "image", pending: false, showSemantic: false })).toBe(0);
  });

  it("matches alias rows by their alias, path/suggest rows without the prefix", () => {
    expect(defaultHighlight({ rows: [{ name: "reference/figure", alias: "fig" }], typed: "fig", pending: false, showSemantic: false })).toBe(0);
    expect(defaultHighlight({ rows: [{ name: "path:refs/characters" }], typed: "path:char", pending: false, showSemantic: false })).toBe(0);
    expect(defaultHighlight({ rows: [{ name: "path:refs/old" }], typed: "path:ol", pending: false, showSemantic: false })).toBe(0);
    expect(defaultHighlight({ rows: [{ name: "path:refs/bold" }], typed: "path:ol", pending: false, showSemantic: false })).toBe(-1);
  });

  it("highlights nothing while results load; the semantic row when it's alone", () => {
    expect(defaultHighlight({ rows: [{ name: "type:image" }], typed: "image", pending: true, showSemantic: false })).toBe(-1);
    expect(defaultHighlight({ rows: [], typed: "red car", pending: false, showSemantic: true })).toBe(0);
  });

  it("Enter commits the typed text while results are pending", () => {
    const rows = [{ name: "type:image" }];
    expect(resolveEnter({ ...base, raw: "image", debounced: "image", rows, pending: true }))
      .toEqual({ kind: "literal", value: "image" });
    expect(resolveEnter({ ...base, raw: "image", debounced: "image", rows, pending: true, navigated: true }))
      .toEqual({ kind: "pick", name: "type:image" });
  });
});

describe("matchRank", () => {
  it("ranks exact, prefix, segment start, substring", () => {
    expect(matchRank("Car", "car")).toBe(0);
    expect(matchRank("cart", "car")).toBe(1);
    expect(matchRank("vehicle/car", "car")).toBe(2);
    expect(matchRank("mass effect", "eff")).toBe(2);
    expect(matchRank("scar/scarf", "car")).toBe(3);
    expect(matchRank("dog", "car")).toBe(-1);
  });
});
