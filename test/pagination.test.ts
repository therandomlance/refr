import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import { executeList } from "refr/server/services/fileQuery";

/** Bidirectional keyset paging: forward (older) via nextCursor, backward
 *  (newer, scrolling up) via the "^" prevCursor a seek page hands back. */
describe("keyset pagination", () => {
  const ids = ["pg1", "pg2", "pg3", "pg4", "pg5"];
  const base = new Date(2022, 3, 1, 12).getTime();
  const t = (i: number) => base + i * 1000;

  it("setup", async () => {
    for (let i = 1; i <= 5; i++) {
      await db.file.upsert({
        where: { id: `pg${i}` },
        create: { id: `pg${i}`, size: 1, mtime: new Date(t(i)), mediaType: "image" },
        update: { mtime: new Date(t(i)) },
      });
    }
  });

  const where = { text: `f.id IN (?,?,?,?,?)`, params: ids };

  it("pages forward newest→oldest", async () => {
    const first = await executeList({ where, sort: "date", limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(["pg5", "pg4"]);
    expect(first.prevCursor ?? null).toBeNull(); // top page has nothing newer
    const next = await executeList({ where, sort: "date", cursor: first.nextCursor, limit: 2 });
    expect(next.items.map((i) => i.id)).toEqual(["pg3", "pg2"]);
  });

  it("seek page exposes a backward cursor for scrolling up", async () => {
    const seek = await executeList({ where, sort: "date", cursor: `!${t(3) + 1}|`, limit: 2 });
    expect(seek.items.map((i) => i.id)).toEqual(["pg3", "pg2"]);
    expect(seek.prevCursor).toBeTruthy();
    const back = await executeList({ where, sort: "date", cursor: seek.prevCursor, limit: 2 });
    expect(back.items.map((i) => i.id)).toEqual(["pg5", "pg4"]);
    expect(back.prevCursor ?? null).toBeNull(); // reached the newest file
  });
});
