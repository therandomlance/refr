import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { initDataDir, paths } from "refr/server/services/dataDir";
import { migrateThumbLayout, thumbPath } from "refr/server/services/thumbs";

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
});
