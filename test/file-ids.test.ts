import crypto from "node:crypto";
import { expect, it } from "vitest";
import { db } from "refr/server/db";
import * as config from "refr/server/services/config";
import { filesRouter } from "refr/server/api/routers/files";

it("pages browse IDs without loading metadata, respecting folders, tags, recursion, and library visibility", async () => {
  const files = filesRouter.createCaller({ db, authed: true, headers: new Headers() });
  const ids = Array.from({ length: 1005 }, (_, i) => crypto.createHash("sha256").update(`select-all-fixture-${i}`).digest("hex"));
  const root = "/select-all_%/folder";
  const tagName = "select-all_%";
  const libraries = config.get().libraries;
  const mtime = new Date(2024, 0, 15);
  const collect = async (input: { pathPrefix?: string; tag?: string; recursive?: boolean }) => {
    const selected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await files.ids({ ...input, cursor });
      expect(page.ids.length).toBeLessThanOrEqual(1000);
      selected.push(...page.ids);
      cursor = page.nextCursor;
    } while (cursor);
    return selected;
  };
  try {
    await db.file.createMany({ data: ids.map((id) => ({ id, size: 1, mtime, mediaType: "image" })) });
    await db.filePath.createMany({ data: ids.map((fileId, i) => ({
      fileId, size: 1, mtime,
      path: `${i < 1001 ? root : i === 1001 ? `${root}/child` : i === 1002 ? `${root}/child/deeper` : i === 1003 ? root.replace("_%", "XX") : "/other-library"}/${i}.jpg`,
    })) });
    // Multiple matching paths/tags must not duplicate a file ID.
    await db.filePath.create({ data: { fileId: ids[0]!, path: `${root}/child/duplicate.jpg`, size: 1, mtime } });
    const parent = await db.tag.create({ data: { name: tagName } });
    const child = await db.tag.create({ data: { name: `${tagName}/child` } });
    const deeper = await db.tag.create({ data: { name: `${tagName}/child/deeper` } });
    const lookalike = await db.tag.create({ data: { name: "select-all_XX/child" } });
    await db.fileTag.createMany({ data: [
      ...ids.slice(0, 1001).map((fileId) => ({ fileId, tagId: parent.id })),
      { fileId: ids[0]!, tagId: child.id }, { fileId: ids[1001]!, tagId: child.id },
      { fileId: ids[1002]!, tagId: deeper.id }, { fileId: ids[1003]!, tagId: lookalike.id },
    ] });
    expect(await collect({ pathPrefix: root, recursive: false })).toEqual(ids.slice(0, 1001).sort());
    expect(await collect({ pathPrefix: root })).toEqual(ids.slice(0, 1003).sort());
    expect(await collect({ tag: tagName, recursive: false })).toEqual(ids.slice(0, 1001).sort());
    expect(await collect({ tag: tagName })).toEqual(ids.slice(0, 1003).sort());
    const first = await files.ids({ pathPrefix: root, limit: 2 });
    expect(Object.keys(first)).toEqual(["ids", "nextCursor"]);
    expect(first.ids).toEqual(ids.slice(0, 1003).sort().slice(0, 2));
    expect(first.nextCursor).toBe(first.ids[1]);
    expect(await files.ids({ pathPrefix: "/no-select-all-fixtures" })).toEqual({ ids: [], nextCursor: null });
    await expect(files.ids({ limit: 1001 })).rejects.toThrow();
    await expect(files.ids({ limit: 0 })).rejects.toThrow();
    const anonymous = filesRouter.createCaller({ db, authed: false, headers: new Headers() });
    await expect(anonymous.ids({ pathPrefix: root })).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    config.patch({ libraries: [{ path: root, timeline: true }, { path: "/other-library", timeline: false }] });
    expect(await collect({})).toEqual(ids.slice(0, 1003).sort());
    config.patch({ libraries: [{ path: root, timeline: false }] });
    expect(await collect({})).toEqual([]);
    expect(await collect({ pathPrefix: root })).toEqual(ids.slice(0, 1003).sort());
  } finally {
    config.patch({ libraries });
    await db.file.deleteMany({ where: { id: { in: ids } } });
    await db.tag.deleteMany({ where: { name: { in: [tagName, `${tagName}/child`, `${tagName}/child/deeper`, "select-all_XX/child"] } } });
  }
});
