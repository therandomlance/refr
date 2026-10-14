import { describe, expect, it, vi } from "vitest";
import { db } from "refr/server/db";
import { deleteTag, invalidateTreeCache, merge, normalize, rename, setTags, tree, undoTags, TagUndoConflict } from "refr/server/services/tags";

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

  it("counts a file once across siblings and an explicit parent tag", async () => {
    await setTags(["t1"], ["a/c"], []);
    expect(new Map((await tree()).map((t) => [t.name, t.count])).get("a/c")).toBe(2);
  });

  it("uses production's case-insensitive tag constraint in the test database", async () => {
    const tag = await db.tag.create({ data: { name: "case-fold-regression" } });
    expect((await db.tag.findUnique({ where: { name: "CASE-FOLD-REGRESSION" } }))?.id).toBe(tag.id);
    await expect(db.tag.create({ data: { name: "CASE-FOLD-REGRESSION" } })).rejects.toMatchObject({ code: "P2002" });
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

  it("snapshots and restores mixed per-file tag changes, including removed ancestors", async () => {
    await db.file.createMany({ data: ["undo1", "undo2"].map((id) => ({ id, size: 1, mtime: new Date(), mediaType: "image" as const })) });
    await setTags(["undo1"], ["undo/root", "keep"], []);
    await setTags(["undo2"], ["other"], []);
    const { changes } = await setTags(["undo1", "undo2"], ["undo/root/child", "new"], ["other"]);
    expect(changes).toEqual([
      { fileId: "undo1", before: ["keep", "undo/root"], after: ["keep", "new", "undo/root/child"] },
      { fileId: "undo2", before: ["other"], after: ["new", "undo/root/child"] },
    ]);
    await undoTags(changes);
    expect(await tagNamesOf("undo1")).toEqual(["keep", "undo/root"]);
    expect(await tagNamesOf("undo2")).toEqual(["other"]);
  });

  it("returns no changes for empty and no-op updates", async () => {
    expect(await setTags([], ["ignored"], [])).toEqual({ changes: [] });
    await db.file.create({ data: { id: "undo-noop", size: 1, mtime: new Date(), mediaType: "image" } });
    await setTags(["undo-noop"], ["same"], []);
    expect((await setTags(["undo-noop"], ["same"], [])).changes).toEqual([]);
  });

  it("rejects stale undo atomically", async () => {
    const { changes } = await setTags(["t1", "t2"], ["undo/conflict"], []);
    await setTags(["t2"], ["later"], []);
    const before = await tagNamesOf("t1");
    await expect(undoTags(changes)).rejects.toBeInstanceOf(TagUndoConflict);
    expect(await tagNamesOf("t1")).toEqual(before);
    expect(await tagNamesOf("t2")).toContain("later");
  });
});

describe("tag tree concurrent loads", () => {
  it("shares cold loads across browse and autocomplete callers", async () => {
    invalidateTreeCache();
    const query = vi.spyOn(db, "$queryRaw");
    try {
      const results = await Promise.all([tree(), tree(), tree()]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
    } finally { query.mockRestore(); invalidateTreeCache(); }
  });

  it("does not cache an old load or clear a newer load after invalidation", async () => {
    invalidateTreeCache();
    let resolveOld!: (rows: { name: string; count: bigint }[]) => void;
    let resolveNew!: (rows: { name: string; count: bigint }[]) => void;
    const oldRows = new Promise<{ name: string; count: bigint }[]>((resolve) => { resolveOld = resolve; });
    const newRows = new Promise<{ name: string; count: bigint }[]>((resolve) => { resolveNew = resolve; });
    const query = vi.spyOn(db, "$queryRaw")
      .mockReturnValueOnce(oldRows as ReturnType<typeof db.$queryRaw>)
      .mockReturnValueOnce(newRows as ReturnType<typeof db.$queryRaw>);
    try {
      const old = tree();
      invalidateTreeCache();
      const current = tree();
      resolveOld([{ name: "old", count: 1n }]);
      await old;
      const concurrent = tree();
      expect(query).toHaveBeenCalledTimes(2);
      resolveNew([{ name: "new", count: 2n }]);
      expect(await current).toEqual([{ name: "new", count: 2 }]);
      expect(await concurrent).toEqual(await tree());
      expect(query).toHaveBeenCalledTimes(2);
    } finally { query.mockRestore(); invalidateTreeCache(); }
  });

  it("retries after a failed cold query", async () => {
    invalidateTreeCache();
    const query = vi.spyOn(db, "$queryRaw").mockRejectedValueOnce(new Error("unavailable"));
    try {
      await expect(tree()).rejects.toThrow("unavailable");
      await tree();
      expect(query).toHaveBeenCalledTimes(2);
    } finally { query.mockRestore(); invalidateTreeCache(); }
  });
});

describe("batched tag edits", () => {
  it("preserves mixed snapshots and undo across chunk boundaries and duplicate ids", async () => {
    const ids = Array.from({ length: 405 }, (_, i) => `bulk-tag-${i}`);
    await db.file.createMany({ data: ids.map((id) => ({ id, size: 1, mtime: new Date(), mediaType: "image" })) });
    try {
      await setTags(ids.slice(0, 10), ["bulk/root/child"], []);
      await setTags(ids.slice(10), ["bulk/root"], []);
      const { changes } = await setTags([...ids, ids[0]!], ["bulk/root/child"], []);
      expect(changes).toHaveLength(395);
      expect(await tagNamesOf(ids[400]!)).toEqual(["bulk/root/child"]);
      expect((await setTags(ids, ["bulk/root/child"], [])).changes).toEqual([]);
      await undoTags(changes);
      expect(await tagNamesOf(ids[0]!)).toEqual(["bulk/root/child"]);
      expect(await tagNamesOf(ids[400]!)).toEqual(["bulk/root"]);
    } finally { await db.file.deleteMany({ where: { id: { in: ids } } }); invalidateTreeCache(); }
  });

  it("rolls back earlier chunks when a file does not exist", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `bulk-rollback-${i}`);
    await db.file.createMany({ data: ids.map((id) => ({ id, size: 1, mtime: new Date(), mediaType: "image" })) });
    try {
      await expect(setTags([...ids, "bulk-missing-file"], ["bulk/rollback"], [])).rejects.toThrow();
      expect(await db.fileTag.count({ where: { fileId: { in: ids } } })).toBe(0);
      expect(await db.tag.findUnique({ where: { name: "bulk/rollback" } })).toBeNull();
    } finally { await db.file.deleteMany({ where: { id: { in: ids } } }); invalidateTreeCache(); }
  });
});
