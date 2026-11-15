import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { db } from "refr/server/db";
import * as config from "refr/server/services/config";
import { scanNow } from "refr/server/services/scanner";
import { deleteTag, merge, rename } from "refr/server/services/tags";
import { readJson, writeJson } from "refr/server/services/jsonStore";
import { paths } from "refr/server/services/dataDir";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("scanner keeps paths of unavailable libraries", () => {
  it("does not unlink a missing/empty library root, but does unlink deleted files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "refr-unavail-"));
    const lib = path.join(root, "lib");
    fs.mkdirSync(lib);
    const keep = path.join(lib, "keep.jpg");
    const gone = path.join(lib, "gone.jpg");
    fs.writeFileSync(keep, "unavail-keep");
    fs.writeFileSync(gone, "unavail-gone");
    const previous = config.get().libraries;
    try {
      config.patch({ libraries: [lib] });
      await scanNow();
      expect(await db.filePath.count({ where: { path: { in: [keep, gone] } } })).toBe(2);

      // simulate an unmounted share: root exists but is empty
      fs.renameSync(lib, path.join(root, "parked"));
      fs.mkdirSync(lib);
      await scanNow();
      expect(await db.filePath.count({ where: { path: { in: [keep, gone] } } })).toBe(2);

      // root missing entirely
      fs.rmdirSync(lib);
      await scanNow();
      expect(await db.filePath.count({ where: { path: { in: [keep, gone] } } })).toBe(2);

      // back online with one file really deleted → only that path unlinks
      fs.renameSync(path.join(root, "parked"), lib);
      fs.rmSync(gone);
      await scanNow();
      expect(await db.filePath.findUnique({ where: { path: keep } })).not.toBeNull();
      expect(await db.filePath.findUnique({ where: { path: gone } })).toBeNull();
    } finally {
      config.patch({ libraries: previous });
      await db.file.deleteMany({ where: { id: { in: [sha("unavail-keep"), sha("unavail-gone")] } } });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tag operations carry suggestion denials", () => {
  const denials = async (prefix: string) =>
    (await db.suggestionDenial.findMany({ where: { tagName: { startsWith: prefix } }, orderBy: [{ tagName: "asc" }, { fileId: "asc" }] }))
      .map((d) => `${d.tagName}:${d.fileId}`).sort();

  it("rename / merge / delete", async () => {
    const ids = ["den-f1", "den-f2"];
    await db.file.createMany({ data: ids.map((id) => ({ id, size: 1, mtime: new Date(), mediaType: "image" })) });
    try {
      await db.tag.createMany({ data: [{ name: "dena" }, { name: "dena/b" }, { name: "denm" }, { name: "denz" }] });
      await db.suggestionDenial.createMany({ data: [
        { tagName: "dena", fileId: "den-f1" },
        { tagName: "dena/b", fileId: "den-f2" },
        { tagName: "denm", fileId: "den-f1" },
        { tagName: "denz", fileId: "den-f1" },
      ] });

      // rename into its own subtree exercises "new names overlap old ones"
      await rename("dena", "dena/x");
      expect(await denials("dena")).toEqual(["dena/x/b:den-f2", "dena/x:den-f1"]);

      // merge: duplicate (denz → denm, same file) collapses
      await merge(["denz"], "denm");
      expect(await denials("denm")).toEqual(["denm:den-f1"]);
      expect(await denials("denz")).toEqual([]);

      await deleteTag("dena");
      expect(await denials("dena")).toEqual([]);
    } finally {
      await db.tag.deleteMany({ where: { name: { startsWith: "den" } } });
      await db.file.deleteMany({ where: { id: { in: ids } } });
    }
  });
});

describe("jsonStore", () => {
  it("keeps a copy of an invalid file before callers overwrite it", () => {
    const file = path.join(paths.root, "review-fixes-store.json");
    const schema = z.object({ n: z.number() });
    fs.writeFileSync(file, JSON.stringify({ n: "not a number" }));
    try {
      expect(readJson(file, schema)).toBeNull();
      expect(readJson(file, schema)).toBeNull(); // second read: no duplicate backup
      const backups = fs.readdirSync(paths.root).filter((f) => f.startsWith("review-fixes-store.json.invalid-"));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(paths.root, backups[0]!), "utf8")).toContain("not a number");
      writeJson(file, { n: 1 });
      expect(readJson(file, schema)).toEqual({ n: 1 });
    } finally {
      for (const f of fs.readdirSync(paths.root)) {
        if (f.startsWith("review-fixes-store.json")) fs.rmSync(path.join(paths.root, f), { force: true });
      }
    }
  });
});

describe("config watcher", () => {
  it("keeps firing after atomic (rename) writes", async () => {
    config.watch();
    const seen: string[] = [];
    const onChange = (c: config.Config) => seen.push(c.scanTime ?? "null");
    config.configEvents.on("change", onChange);
    const original = fs.readFileSync(paths.config, "utf8");
    const externalWrite = (scanTime: string) => {
      const next = original.replace(/^scanTime:.*$/m, `scanTime: "${scanTime}"`);
      fs.writeFileSync(paths.config + ".ext", next);
      fs.renameSync(paths.config + ".ext", paths.config);
    };
    try {
      for (const t of ["01:11", "02:22", "03:33"]) {
        externalWrite(t);
        await expect.poll(() => seen.at(-1), { timeout: 3000 }).toBe(t);
      }
    } finally {
      config.configEvents.off("change", onChange);
      fs.writeFileSync(paths.config, original);
    }
  });
});
