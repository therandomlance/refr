import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "refr/server/db";
import { scanNow, purgeOrphans } from "refr/server/services/scanner";
import { executeList, pathPrefixWhere } from "refr/server/services/fileQuery";
import * as config from "refr/server/services/config";
import { setTags, forFiles } from "refr/server/services/tags";

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
});
