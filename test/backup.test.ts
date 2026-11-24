import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import { paths } from "refr/server/services/dataDir";
import { exportLines, importLines, listSnapshots, snapshotDb, type ExportLine } from "refr/server/services/backup";
import { setFavorite, setMeta } from "refr/server/services/fileMeta";
import { setTags } from "refr/server/services/tags";
import * as config from "refr/server/services/config";
import { searchRouter } from "refr/server/api/routers/search";
import { makeToken } from "refr/server/services/search";

async function* from(lines: string[]) { yield* lines; }

describe("tag export / import", () => {
  it("round-trips tags, favorites, sources and notes; matches by hash then path", async () => {
    await db.file.create({ data: { id: "bk1", size: 1, mtime: new Date(), mediaType: "image", paths: { create: { path: "/lib/bk/one.png", size: 1n, mtime: new Date() } } } });
    await db.file.create({ data: { id: "bk2", size: 1, mtime: new Date(), mediaType: "image", paths: { create: { path: "/lib/bk/two.png", size: 1n, mtime: new Date() } } } });
    await setTags(["bk1"], ["bkexport/a", "bkexport/b"], []);
    await setFavorite(["bk1"], true);
    await setMeta("bk1", { source: "https://example.test/bk1", note: "# hi" });

    const lines: ExportLine[] = [];
    for await (const l of exportLines()) lines.push(JSON.parse(l) as ExportLine);
    const mine = lines.find((l) => l.id === "bk1")!;
    expect(mine).toEqual({ id: "bk1", paths: ["/lib/bk/one.png"], tags: ["bkexport/a", "bkexport/b"], favorite: true, source: "https://example.test/bk1", note: "# hi" });
    expect(lines.some((l) => l.id === "bk2")).toBe(false); // nothing to back up

    // re-import onto the same db is a no-op; a renamed hash matches by path
    expect(await importLines(from([JSON.stringify(mine)]))).toMatchObject({ matched: 1, changedFiles: 0 });
    const moved = { ...mine, id: "f".repeat(64), paths: ["/lib/bk/two.png"] };
    const report = await importLines(from([JSON.stringify(moved), JSON.stringify({ ...mine, id: "e".repeat(64), paths: ["/nowhere.png"] }), "{broken"]));
    expect(report).toEqual({ lines: 3, matched: 1, unmatched: 1, invalid: 1, changedFiles: 1 });
    const tags = (await db.fileTag.findMany({ where: { fileId: "bk2" }, include: { tag: true } })).map((t) => t.tag.name).sort();
    expect(tags).toEqual(["bkexport/a", "bkexport/b"]);
    expect(await db.fileMeta.findUnique({ where: { fileId: "bk2" } })).toMatchObject({ favorite: true, source: "https://example.test/bk1", note: "# hi" });

    const search = searchRouter.createCaller({ db, authed: true, headers: new Headers() });
    const ids = async (tag: string) => (await search.query({ tokens: [makeToken({ tag: "bkexport" }), makeToken({ tag })], sort: "date" })).items.map((i) => i.id).sort();
    expect(await ids("has:note")).toEqual(["bk1", "bk2"]);
    expect(await ids("source:EXAMPLE.test")).toEqual(["bk1", "bk2"]);
  });
});

describe("snapshots", () => {
  it("writes a consistent copy and prunes to keep", async () => {
    fs.rmSync(paths.backups, { recursive: true, force: true });
    config.patch({ backup: { keep: 2 } });
    try {
      for (let i = 0; i < 3; i++) {
        const name = await snapshotDb();
        // names are per-second; make the next one distinct
        if (i < 2) fs.renameSync(`${paths.backups}/${name}`, `${paths.backups}/refr-2000010${i}-000000.db`);
      }
      const snaps = listSnapshots();
      expect(snaps).toHaveLength(2);
      expect(snaps[0]!.size).toBeGreaterThan(0);
      expect(snaps.map((s) => s.name)).not.toContain("refr-20000100-000000.db");
    } finally {
      config.patch({ backup: { keep: 7 } });
    }
  });
});
