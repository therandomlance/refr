import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDataDir, paths } from "refr/server/services/dataDir";
import { catchUpMissingThumbs, enqueueThumbs, migrateThumbLayout, setOnThumbDrain, thumbPath, thumbStatus } from "refr/server/services/thumbs";
import { db } from "refr/server/db";

const idA = "ab" + "0".repeat(62);
const idB = "cd" + "1".repeat(62);

describe("thumbnail storage layout", () => {
  beforeEach(() => {
    initDataDir();
    fs.rmSync(paths.thumbnails, { recursive: true, force: true });
    fs.mkdirSync(paths.thumbnails, { recursive: true });
  });

  it("shards by the first two hex chars", () => {
    expect(thumbPath(idA)).toBe(path.join(paths.thumbnails, "ab", `${idA}.webp`));
  });

  it("migrates flat files into shard dirs", async () => {
    fs.writeFileSync(path.join(paths.thumbnails, `${idA}.webp`), "a");
    fs.writeFileSync(path.join(paths.thumbnails, `${idB}.webp`), "b");

    expect(await migrateThumbLayout()).toBe(2);

    expect(fs.existsSync(thumbPath(idA))).toBe(true);
    expect(fs.existsSync(thumbPath(idB))).toBe(true);
    expect(fs.existsSync(path.join(paths.thumbnails, `${idA}.webp`))).toBe(false);
  });

  it("is idempotent on an already-sharded dir", async () => {
    fs.mkdirSync(path.dirname(thumbPath(idA)), { recursive: true });
    fs.writeFileSync(thumbPath(idA), "a");
    expect(await migrateThumbLayout()).toBe(0);
    expect(fs.existsSync(thumbPath(idA))).toBe(true);
  });

  it("deduplicates jobs while queued and active", async () => {
    const before = thumbStatus().processed;
    const drained = new Promise<void>((resolve) => setOnThumbDrain(resolve));
    const job = { fileId: idA, mediaType: "image", path: "/missing" };
    enqueueThumbs([job]);
    enqueueThumbs([job]);
    await drained;
    setOnThumbDrain(null);
    expect(thumbStatus().processed - before).toBe(1);
  });

  it("pages catch-up and coalesces producers until the bounded queue drains", async () => {
    const files = Array.from({ length: 310 }, (_, i) => ({
      id: i.toString(16).padStart(64, "0"), size: 1n, mtime: new Date(0), addedAt: new Date(0),
      mediaType: "image", width: null, height: null, duration: null, paths: [{ path: "/missing" }],
    }));
    const read = vi.spyOn(db.file, "findMany");
    for (let i = 0; i < files.length; i += 100) read.mockResolvedValueOnce(files.slice(i, i + 100));
    const before = thumbStatus().processed;
    const drained = new Promise<void>((resolve) => setOnThumbDrain(resolve));
    try {
      const run = catchUpMissingThumbs();
      expect(catchUpMissingThumbs()).toBe(run);
      expect(thumbStatus().running).toBe(true);
      await run;
      expect(thumbStatus().pending).toBeLessThanOrEqual(256);
      await drained;
      expect(thumbStatus().running).toBe(false);
      expect(thumbStatus().processed - before).toBe(310);
      expect(read).toHaveBeenCalledTimes(4);
      expect(read.mock.calls.every(([args]) => args?.take === 100)).toBe(true);
      expect(read.mock.calls[1]?.[0]?.where?.id).toEqual({ gt: files[99]!.id });
    } finally { read.mockRestore(); setOnThumbDrain(null); }
  });
});
