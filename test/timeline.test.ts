import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import { timelineBuckets } from "refr/server/services/fileQuery";

describe("timeline buckets", () => {
  const ids = ["tl1", "tl2", "tl3"];
  const jan1 = new Date(2020, 0, 15, 12).getTime();
  const jan2 = new Date(2020, 0, 20, 12).getTime();
  const jul = new Date(2021, 6, 4, 12).getTime();

  it("setup", async () => {
    const rows = [
      { id: "tl1", mtime: jan1 },
      { id: "tl2", mtime: jan2 },
      { id: "tl3", mtime: jul },
    ];
    for (const r of rows) {
      await db.file.upsert({
        where: { id: r.id },
        create: { id: r.id, size: 1, mtime: new Date(r.mtime), mediaType: "image" },
        update: { mtime: new Date(r.mtime) },
      });
    }
    const paths = [
      { path: "/tllib/a.png", fileId: "tl1" },
      { path: "/tllib/b.png", fileId: "tl2" },
      { path: "/otherlib/c.png", fileId: "tl3" },
    ];
    for (const p of paths) {
      await db.filePath.upsert({
        where: { path: p.path },
        create: { ...p, size: 1, mtime: new Date() },
        update: { fileId: p.fileId },
      });
    }
  });

  it("groups by local month, newest first, with count + mtime range", async () => {
    const where = { text: `f.id IN (?,?,?)`, params: ids };
    const buckets = await timelineBuckets(where);
    expect(buckets.map((b) => `${b.year}-${b.month}`)).toEqual(["2021-7", "2020-1"]);
    expect(buckets[0]!.count).toBe(1);
    expect(buckets[1]!.count).toBe(2);
    expect(buckets[1]!.maxMtime).toBe(jan2);
    expect(buckets[1]!.minMtime).toBe(jan1);
  });

  it("roots limit buckets to enabled libraries", async () => {
    const where = { text: `f.id IN (?,?,?)`, params: ids };
    const only = await timelineBuckets(where, ["/tllib"]);
    expect(only.map((b) => `${b.year}-${b.month}`)).toEqual(["2020-1"]);
    expect(only[0]!.count).toBe(2);
    expect(await timelineBuckets(where, [])).toEqual([]);
  });
});
