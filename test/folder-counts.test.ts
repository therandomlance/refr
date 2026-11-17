import { expect, it } from "vitest";
import { db } from "refr/server/db";
import { folderFileCount, subfolderFileCounts } from "refr/server/services/fileQuery";

it("counts distinct files recursively per folder", async () => {
  const root = "/fc-lib";
  const rows: [string, string][] = [
    ["fc1", `${root}/a/one.png`],
    ["fc2", `${root}/a/deep/two.png`],
    ["fc1", `${root}/b/dup-of-one.png`], // same content in two folders
    ["fc3", `${root}/top.png`], // direct child file, not a subfolder
    ["fc4", `${root}-sibling/x.png`], // shares the prefix string, not the folder
  ];
  for (const id of new Set(rows.map(([id]) => id))) {
    await db.file.upsert({ where: { id }, create: { id, size: 1, mtime: new Date(), mediaType: "image" }, update: {} });
  }
  for (const [fileId, path] of rows) {
    await db.filePath.upsert({ where: { path }, create: { path, fileId, size: 1, mtime: new Date() }, update: {} });
  }

  expect(await folderFileCount(root)).toBe(3);
  expect(await folderFileCount(`${root}/a`)).toBe(2);
  const subs = await subfolderFileCounts(root);
  expect(Object.fromEntries(subs)).toEqual({ a: 2, b: 1 });
});
