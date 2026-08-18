import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import { deleteTag, merge, normalize, rename, setTags, tree } from "refr/server/services/tags";

async function tagNamesOf(fileId: string): Promise<string[]> {
  const rows = await db.fileTag.findMany({ where: { fileId }, include: { tag: true } });
  return rows.map((r) => r.tag.name).sort();
}

describe("tags", () => {
  it("normalize", () => {
    expect(normalize("  /A//B/  ")).toBe("a/b");
  });

  it("setup", async () => {
    await db.file.create({ data: { id: "t1", size: 1, mtime: new Date(), mediaType: "image" } });
    await db.file.create({ data: { id: "t2", size: 1, mtime: new Date(), mediaType: "image" } });
    await setTags(["t1"], ["a/b/c", "a/b/d"], []);
    await setTags(["t2"], ["a/b/c", "x"], []);
  });

  it("rename rewrites descendants and merges collisions", async () => {
    await rename("a/b", "a/c");
    expect(await tagNamesOf("t1")).toEqual(["a/c/c", "a/c/d"]);
    // t2: a/b/c → a/c/c; if target exists it merges rather than duplicating
    expect(await tagNamesOf("t2")).toEqual(["a/c/c", "x"]);
  });

  it("merge dedupes links", async () => {
    await merge(["x"], "a/c/c");
    expect(await tagNamesOf("t2")).toEqual(["a/c/c"]);
  });

  it("tree counts roll up prefixes", async () => {
    const counts = new Map((await tree()).map((t) => [t.name, t.count]));
    expect(counts.get("a")).toBe(2);
    expect(counts.get("a/c")).toBe(2);
    expect(counts.get("a/c/c")).toBe(2);
    expect(counts.get("a/c/d")).toBe(1);
  });

  it("delete removes descendants", async () => {
    await deleteTag("a/c");
    const names = (await tree()).map((t) => t.name);
    expect(names).not.toContain("a/c");
    expect(names).not.toContain("a/c/c");
    expect(names).not.toContain("a/c/d");
  });

  it("adding a specific tag removes redundant parent tags", async () => {
    await db.file.create({ data: { id: "red1", size: 1, mtime: new Date(), mediaType: "image" } });
    await setTags(["red1"], ["artwork/fanart"], []);
    expect(await tagNamesOf("red1")).toEqual(["artwork/fanart"]);
    // adding the more specific child makes the parent redundant
    await setTags(["red1"], ["artwork/fanart/warframe/loki"], []);
    expect(await tagNamesOf("red1")).toEqual(["artwork/fanart/warframe/loki"]);
  });
});
