import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import { timelineBuckets, timelineMonth } from "refr/server/services/fileQuery";

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

  it("loads a complete dense month in stable order, with the same filters and exact month boundaries", async () => {
    const ids = Array.from({ length: 601 }, (_, i) => `dense-${String(i).padStart(4, "0")}`);
    const start = new Date(2024, 1, 1);
    const end = new Date(2024, 2, 1);
    await db.file.createMany({ data: ids.map((id, i) => ({
      id, size: 1, mediaType: "image", mtime: i === 600 ? end : start,
    })) });
    const where = { text: "f.id LIKE ?", params: ["dense-%"] };
    const month = await timelineMonth(where, { year: 2024, month: 2 });
    expect(month.items.map((f) => f.id)).toEqual(ids.slice(0, 600).reverse());
    expect(month.items.every((f) => f.mtime === start.getTime())).toBe(true);
    expect(month.nextCursor).toBeNull();
    expect((await timelineMonth({ text: "1=0", params: [] }, { year: 2024, month: 2 })).items).toEqual([]);
  });
});
