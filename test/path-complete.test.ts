import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "refr/server/db";
import { pathComplete, resetFolderIndex } from "refr/server/services/pathComplete";

// a real directory tree (navigation reads the disk) + FilePath rows (fuzzy reads the db)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "refr-pc-"));
const other = fs.mkdtempSync(path.join(os.tmpdir(), "refr-pc-abs-"));
const libs = [{ root, alias: "pcrefs" }, { root: other }];
const dirs = ["characters/liara", "characters/shepard", "environments/sci-fi", "old/archive"];
const files: [string, string][] = [
  ["pc1", "characters/liara/a.png"],
  ["pc2", "characters/liara/b.png"],
  ["pc3", "characters/shepard/c.png"],
  ["pc4", "environments/sci-fi/d.png"],
  ["pc5", "old/archive/e.png"],
];

beforeAll(async () => {
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(other, "scans"), { recursive: true });
  const all: [string, string][] = [...files.map(([id, p]): [string, string] => [id, path.join(root, p)]), ["pc6", path.join(other, "scans/f.png")]];
  for (const [id, p] of all) {
    await db.file.upsert({ where: { id }, create: { id, size: 1, mtime: new Date(), mediaType: "image" }, update: {} });
    await db.filePath.upsert({ where: { path: p }, create: { path: p, fileId: id, size: 1, mtime: new Date() }, update: {} });
  }
});
beforeEach(() => resetFolderIndex());
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

const names = async (typed: string) => (await pathComplete(typed, libs)).map((r) => r.name);

it("lists aliases / roots for an empty term", async () => {
  expect(await names("")).toEqual(["pcrefs", other]);
});

it("an existing folder lists itself before its subfolders", async () => {
  expect((await names("pcrefs")).slice(0, 4)).toEqual(["pcrefs", "pcrefs/characters", "pcrefs/environments", "pcrefs/old"]);
  expect((await names("pcrefs/characters")).slice(0, 3)).toEqual([
    "pcrefs/characters",
    "pcrefs/characters/liara",
    "pcrefs/characters/shepard",
  ]);
  expect((await names(other)).slice(0, 2)).toEqual([other, path.join(other, "scans")]);
});

it("fuzzy-matches folders anywhere in a library, segment starts first", async () => {
  const rows = await names("lia");
  expect(rows[0]).toBe("pcrefs/characters/liara");
  expect(await names("fi")).toContain("pcrefs/environments/sci-fi");
  // non-aliased library: matched under its folder name, shown as an absolute path
  expect(await names("scan")).toContain(path.join(other, "scans"));
  // mid-word only
  expect(await names("hepa")).toEqual(["pcrefs/characters/shepard"]);
});

it("attaches recursive file counts", async () => {
  const rows = await pathComplete("char", libs);
  expect(rows.find((r) => r.name === "pcrefs/characters")?.count).toBe(3);
  expect(rows.find((r) => r.name === "pcrefs/characters/liara")?.count).toBe(2);
});
