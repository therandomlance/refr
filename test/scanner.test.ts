import { describe, expect, it, beforeAll, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "refr/server/db";
import { scanNow, purgeOrphans, displayDims } from "refr/server/services/scanner";
import { executeList, pathPrefixWhere } from "refr/server/services/fileQuery";
import * as config from "refr/server/services/config";
import { setTags, forFiles } from "refr/server/services/tags";
import { thumbPath, thumbStatus } from "refr/server/services/thumbs";

const LIB = "/tmp/refr-vitest-lib";

async function idsInDb(): Promise<string[]> {
  return (await db.file.findMany({ select: { id: true } })).map((f) => f.id).sort();
}

function hashOf(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

describe("scanner", () => {
  beforeAll(() => {
    fs.rmSync(LIB, { recursive: true, force: true });
    fs.mkdirSync(path.join(LIB, "sub"), { recursive: true });
  });

  it("indexes new files", async () => {
    fs.writeFileSync(path.join(LIB, "a.jpg"), Buffer.from("aaa"));
    fs.writeFileSync(path.join(LIB, "sub/b.jpg"), Buffer.from("bbb"));
    config.patch({ libraries: [LIB] });
    await scanNow();
    const ids = await idsInDb();
    expect(ids).toContain(hashOf(path.join(LIB, "a.jpg")));
    expect(ids).toContain(hashOf(path.join(LIB, "sub/b.jpg")));
  });

  it("folder listing matches direct children only, not subfolders", async () => {
    const res = await executeList({ where: pathPrefixWhere(LIB), sort: "date" });
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain(hashOf(path.join(LIB, "a.jpg")));
    expect(ids).not.toContain(hashOf(path.join(LIB, "sub/b.jpg")));
  });

  it("stats unchanged known paths once while still discovering new files", async () => {
    const known = path.join(LIB, "a.jpg");
    const added = path.join(LIB, "new.jpg");
    fs.writeFileSync(added, "scan-new-file");
    const stat = vi.spyOn(fsp, "stat");
    try {
      await scanNow();
      expect(stat.mock.calls.filter(([p]) => p === known)).toHaveLength(1);
      expect((await db.filePath.findUnique({ where: { path: added } }))?.fileId).toBe(hashOf(added));
    } finally { stat.mockRestore(); }
  });

  it("rename keeps tags", async () => {
    const id = hashOf(path.join(LIB, "a.jpg"));
    await setTags([id], ["keepme"], []);
    fs.renameSync(path.join(LIB, "a.jpg"), path.join(LIB, "renamed.jpg"));
    await scanNow();
    const tags = await forFiles([id]);
    expect(tags).toContain("keepme");
    const row = await db.filePath.findUnique({ where: { path: path.join(LIB, "renamed.jpg") } });
    expect(row?.fileId).toBe(id);
  });

  it("content change re-hashes and moves path", async () => {
    const oldId = hashOf(path.join(LIB, "renamed.jpg"));
    fs.writeFileSync(path.join(LIB, "renamed.jpg"), Buffer.from("cccccccc"));
    await scanNow();
    const newId = hashOf(path.join(LIB, "renamed.jpg"));
    expect(newId).not.toBe(oldId);
    const row = await db.filePath.findUnique({ where: { path: path.join(LIB, "renamed.jpg") } });
    expect(row?.fileId).toBe(newId);
    // old file row stays (tags preserved), just zero paths
    const old = await db.file.findUnique({ where: { id: oldId }, include: { paths: true } });
    expect(old).not.toBeNull();
    expect(old!.paths).toHaveLength(0);
  });

  it("prunes vanished paths, file row retained", async () => {
    const id = hashOf(path.join(LIB, "sub/b.jpg"));
    fs.rmSync(path.join(LIB, "sub/b.jpg"));
    await scanNow();
    const row = await db.file.findUnique({ where: { id }, include: { paths: true } });
    expect(row!.paths).toHaveLength(0);
    expect(await db.filePath.count({ where: { path: path.join(LIB, "sub/b.jpg") } })).toBe(0);
  });

  it("purge deletes orphaned files", async () => {
    const orphaned = await db.file.findMany({ where: { paths: { none: {} } }, select: { id: true } });
    expect(orphaned.length).toBeGreaterThan(0);
    await purgeOrphans();
    expect(await db.file.count({ where: { paths: { none: {} } } })).toBe(0);
  });

  it("uses EXIF display orientation for thumbnails and indexed dimensions without changing originals", async () => {
    const sharp = (await import("sharp")).default;
    const source = await sharp(Buffer.from(
      '<svg width="80" height="48"><rect width="80" height="48" fill="white"/><rect width="40" height="24" fill="red"/><rect x="40" width="40" height="24" fill="#00ff00"/><rect y="24" width="40" height="24" fill="blue"/></svg>',
    )).jpeg().toBuffer();
    // Expected RGB corner colors: top-left, top-right, bottom-left, bottom-right.
    const cases = [
      [undefined, ["100", "010", "001", "111"]],
      [1, ["100", "010", "001", "111"]],
      [2, ["010", "100", "111", "001"]],
      [3, ["111", "001", "010", "100"]],
      [4, ["001", "111", "100", "010"]],
      [5, ["100", "001", "010", "111"]],
      [6, ["001", "100", "111", "010"]],
      [7, ["111", "010", "001", "100"]],
      [8, ["010", "111", "100", "001"]],
    ] as const;
    const fixtures = [];
    const libraries = config.get().libraries;
    config.patch({ libraries: [LIB] });
    try {
      for (const [orientation, corners] of cases) {
        const file = path.join(LIB, `camera-${orientation ?? "none"}.jpg`);
        const image = sharp(source);
        if (orientation) image.withMetadata({ orientation });
        await image.toFile(file);
        fixtures.push({ file, id: hashOf(file), orientation, corners });
      }
      await scanNow();
      await vi.waitFor(() => expect(thumbStatus().running).toBe(false));
      for (const { file, id, orientation, corners } of fixtures) {
        const swap = orientation != null && orientation >= 5;
        const dims = { width: swap ? 48 : 80, height: swap ? 80 : 48 };
        expect(await db.file.findUnique({ where: { id } })).toMatchObject(dims);
        const { data, info } = await sharp(thumbPath(id)).raw().toBuffer({ resolveWithObject: true });
        expect(info).toMatchObject(dims);
        const actual = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => {
          const offset = (Math.floor(y! * info.height) * info.width + Math.floor(x! * info.width)) * info.channels;
          return [...data.subarray(offset, offset + 3)].map((v) => Math.round(v / 255)).join("");
        });
        expect(actual).toEqual(corners);
        expect((await sharp(thumbPath(id)).metadata()).orientation).toBeUndefined();
        expect(hashOf(file)).toBe(id);
      }
    } finally {
      config.patch({ libraries });
      for (const { file } of fixtures) fs.rmSync(file, { force: true });
    }
  });

  it("shares scan ownership and progress across module instances", async () => {
    vi.resetModules();
    const other = await import("refr/server/services/scanner");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(db.filePath, "findMany").mockReturnValueOnce(gate.then(() => []) as ReturnType<typeof db.filePath.findMany>);
    const run = scanNow();
    try {
      expect(other.scanNow()).toBe(run);
      expect(other.scanStatus().running).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await run;
      read.mockRestore();
    }
    expect(other.scanStatus().running).toBe(false);
  });
});

describe("displayDims (video rotation)", () => {
  it("swaps coded dims for 90/270 rotations (phone portrait videos)", () => {
    expect(displayDims(1920, 1080, -90)).toEqual({ width: 1080, height: 1920 });
    expect(displayDims(1920, 1080, 270)).toEqual({ width: 1080, height: 1920 });
    expect(displayDims(1920, 1080, 450)).toEqual({ width: 1080, height: 1920 });
  });

  it("keeps orientation for 0/180/45/undefined", () => {
    expect(displayDims(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
    expect(displayDims(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 });
    expect(displayDims(1920, 1080, undefined)).toEqual({ width: 1920, height: 1080 });
  });
});
