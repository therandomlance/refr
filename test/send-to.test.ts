import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { expect, it } from "vitest";
import { db } from "refr/server/db";
import * as config from "refr/server/services/config";
import { filesRouter } from "refr/server/api/routers/files";
import { settingsRouter } from "refr/server/api/routers/settings";

it("sends the whole selection, skips existing filenames, and keeps going after missing files", async () => {
  const root = fs.mkdtempSync("/tmp/opencode/refr-send-to-");
  const dest = path.join(root, "destination");
  const previous = config.get().sendToPaths;
  const ctx = { db, authed: true, headers: new Headers() };
  const files = filesRouter.createCaller(ctx);
  const settings = settingsRouter.createCaller(ctx);
  const ids: string[] = [];
  const addFile = async (folder: string, name: string, content: string) => {
    const source = path.join(root, folder, name);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, content);
    const id = crypto.createHash("sha256").update(content).digest("hex");
    ids.push(id);
    await db.file.create({ data: {
      id, size: content.length, mtime: new Date(), mediaType: "image",
      paths: { create: { path: source, size: content.length, mtime: new Date() } },
    } });
    return { id, source };
  };
  try {
    // Existing YAML paths continue working; settings can edit the path and its menu name together.
    config.patch({ sendToPaths: [path.join(root, "old-destination")] });
    expect((await settings.get()).sendToPaths[0]?.path).toBe(path.join(root, "old-destination"));
    await settings.patch({ sendToPaths: [{ path: dest, alias: "Drawing references" }] });
    expect((await settings.get()).sendToPaths).toEqual([{ path: dest, alias: "Drawing references" }]);
    await expect(settings.patch({ sendToPaths: [{ path: "  " }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const first = await addFile("library", "first.jpg", "first image");
    const second = await addFile("library", "second.png", "second image");
    const missing = await addFile("library", "missing.jpg", "vanished image");
    const broken = await addFile("library", "broken.jpg", "replaced image");
    const collision = await addFile("other-library", "first.jpg", "different image, same name");
    fs.unlinkSync(missing.source);
    fs.unlinkSync(broken.source);
    fs.mkdirSync(broken.source);

    await expect(files.sendTo({ fileIds: [first.id], destIndex: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(files.sendTo({ fileIds: [], destIndex: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(filesRouter.createCaller({ ...ctx, authed: false }).sendTo({ fileIds: [first.id], destIndex: 0 }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fs.existsSync(dest)).toBe(false);

    const sent = await files.sendTo({ fileIds: [first.id, missing.id, broken.id, second.id, collision.id, first.id], destIndex: 0 });
    expect(sent.copied).toEqual(["first.jpg", "second.png"]);
    expect(sent.existing).toEqual(["first.jpg"]);
    expect(sent.failed).toEqual([
      { id: missing.id, name: "missing.jpg", message: "no existing path for file" },
      { id: broken.id, name: "broken.jpg", message: expect.stringContaining("EISDIR") },
    ]);
    expect(fs.readdirSync(dest).sort()).toEqual(["first.jpg", "second.png"]);
    expect(fs.readFileSync(path.join(dest, "first.jpg"), "utf8")).toBe("first image");
    expect(fs.readFileSync(path.join(dest, "second.png"), "utf8")).toBe("second image");
    expect(fs.readFileSync(collision.source, "utf8")).toBe("different image, same name");

    const repeated = await files.sendTo({ fileIds: [first.id, second.id], destIndex: 0 });
    expect(repeated).toEqual({ copied: [], existing: ["first.jpg", "second.png"], failed: [] });

    // Two simultaneous sends to a new filename still produce exactly one copy.
    fs.unlinkSync(path.join(dest, "second.png"));
    const concurrent = await Promise.all([
      files.sendTo({ fileIds: [second.id], destIndex: 0 }),
      files.sendTo({ fileIds: [second.id], destIndex: 0 }),
    ]);
    expect(concurrent.flatMap((r) => r.copied)).toEqual(["second.png"]);
    expect(concurrent.flatMap((r) => r.existing)).toEqual(["second.png"]);
    expect(concurrent.flatMap((r) => r.failed)).toEqual([]);
    expect(fs.readFileSync(path.join(dest, "second.png"), "utf8")).toBe("second image");

    // Clearing an alias restores the filename-based menu label and persists to YAML.
    await settings.patch({ sendToPaths: [{ path: dest, alias: "" }] });
    expect((await settings.get()).sendToPaths[0]?.alias).toBeUndefined();
  } finally {
    config.patch({ sendToPaths: previous });
    await db.file.deleteMany({ where: { id: { in: ids } } });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
