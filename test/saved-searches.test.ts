import { describe, expect, it } from "vitest";
import {
  childrenAt,
  locateFolder,
  moveNode,
  nodeKeyAt,
  type SavedFolderNode,
  type SavedNode,
  type SavedSearchNode,
} from "refr/lib/saved-searches";

const s = (name: string): SavedSearchNode => ({ t: "search", name, tokens: [] });
const f = (name: string, children: SavedNode[] = []): SavedFolderNode => ({ t: "folder", name, children });
const names = (items: SavedNode[]): string[] =>
  items.map((n) => (n.t === "search" ? n.name : `[${n.name}:${names(n.children).join(",")}]`));

describe("moveNode", () => {
  it("reorders within root before a sibling", () => {
    const items = [s("A"), s("B"), s("C")];
    expect(names(moveNode(items, "s:A", null, "s:B"))).toEqual(["A", "B", "C"]);
    expect(names(moveNode(items, "s:C", null, "s:A"))).toEqual(["C", "A", "B"]);
  });

  it("does not shift the wrong way when moving down the list", () => {
    const items = [s("A"), s("B"), s("C")];
    // drag A before C (i.e. after B) — the node is removed first, then inserted
    expect(names(moveNode(items, "s:A", null, "s:C"))).toEqual(["B", "A", "C"]);
  });

  it("moves a search into and out of a folder", () => {
    const items = [s("A"), f("F", [s("B")]), s("C")];
    expect(names(moveNode(items, "s:A", "F", null))).toEqual(["[F:B,A]", "C"]);
    const back = moveNode(items, "s:B", null, "s:C");
    expect(names(back)).toEqual(["A", "[F:]", "B", "C"]);
  });

  it("nests a folder inside another and reorders at that level", () => {
    const items = [f("F1", [f("F2")]), s("A")];
    const nested = moveNode(items, "f:F1/F2", null, "s:A");
    expect(names(nested)).toEqual(["[F1:]", "[F2:]", "A"]);
    // move A into F1, before nothing (append) → becomes second child
    const into = moveNode(nested, "s:A", "F1", null);
    expect(names(into)).toEqual(["[F1:A]", "[F2:]"]);
  });

  it("refuses to nest a folder into itself or a descendant", () => {
    const items = [f("F1", [f("F2")]), s("A")];
    expect(moveNode(items, "f:F1", "F1", null)).toEqual(items);
    expect(moveNode(items, "f:F1", "F1/F2", null)).toEqual(items);
  });

  it("appends when beforeKey is missing", () => {
    const items = [s("A"), f("F", [s("B")])];
    expect(names(moveNode(items, "s:A", null, "s:GONE"))).toEqual(["[F:B]", "A"]);
  });
});

describe("tree helpers", () => {
  const items = [f("F1", [f("F2", [s("deep")]), s("kid")]), s("root")];

  it("keys folders by path and searches by name", () => {
    expect(nodeKeyAt(s("x"), null)).toBe("s:x");
    expect(nodeKeyAt(f("x"), null)).toBe("f:x");
    expect(nodeKeyAt(f("x"), "p/q")).toBe("f:p/q/x");
  });

  it("locates nested folders", () => {
    expect(locateFolder(items, "F1/F2")?.folder.name).toBe("F2");
    expect(locateFolder(items, "F1/Nope")).toBeNull();
    expect(names(childrenAt(items, "F1")!)).toEqual(["[F2:deep]", "kid"]);
    expect(names(childrenAt(items, null)!)).toEqual(["[F1:[F2:deep],kid]", "root"]);
  });
});
