import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { db } from "refr/server/db";
import { createFolder, deleteFolder, extract, list, move, remove, renameFolder, save } from "refr/server/services/palettes";

describe("palette median cut", () => {
  it("returns N well-formed hex colors", async () => {
    const sharp = (await import("sharp")).default;
    const file = "/tmp/refr-vitest-palette.png";
    // synthetic bitmap: red half, blue half with green stripe
    await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 200, g: 40, b: 40 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="64" height="64"><rect width="32" height="64" fill="#3232c8"/></svg>`,
          ),
        },
      ])
      .png()
      .toFile(file);

    await db.file.create({
      data: { id: "pal1", size: 1, mtime: new Date(), mediaType: "image" },
    });
    await db.filePath.create({ data: { path: file, fileId: "pal1", size: 1, mtime: new Date() } });

    const colors = await extract("pal1", 4);
    expect(colors).toHaveLength(4);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    fs.rmSync(file, { force: true });
  });
});

describe("palette storage", () => {
  it("save dedupes taken names with (N); overwrite edits in place", () => {
    const n1 = save({ name: "vitest-dedupe", colors: ["#112233"] }, "");
    const n2 = save({ name: "vitest-dedupe", colors: ["#445566"] }, "");
    expect(n1).toBe("vitest-dedupe");
    expect(n2).toBe("vitest-dedupe (2)");
    expect(save({ name: "vitest-dedupe", colors: ["#112233"] }, "", true)).toBe("vitest-dedupe");
    const entries = list().items.filter((p) => p.name.startsWith("vitest-dedupe"));
    expect(entries.map((e) => e.name).sort()).toEqual(["vitest-dedupe", "vitest-dedupe (2)"]);
    expect(entries.find((e) => e.name === "vitest-dedupe")?.colors).toEqual(["#112233"]);
    remove("vitest-dedupe", "");
    remove("vitest-dedupe (2)", "");
  });

  it("sourceFileId persists", () => {
    save({ name: "vitest-src", colors: ["#112233"], sourceFileId: "abc123" }, "");
    expect(list().items.find((p) => p.name === "vitest-src")?.sourceFileId).toBe("abc123");
    remove("vitest-src", "");
  });

  it("folders: create lists it, delete moves palettes to unfiled", () => {
    createFolder("vitest-folder");
    expect(list().folders).toContain("vitest-folder");
    save({ name: "vitest-inf", colors: ["#112233"] }, "vitest-folder");
    deleteFolder("vitest-folder");
    expect(list().folders).not.toContain("vitest-folder");
    expect(list().items.find((p) => p.name === "vitest-inf")?.folder).toBe("");
    remove("vitest-inf", "");
  });

  it("moving into the palette's own folder is a no-op, not a rename to (2)", () => {
    createFolder("vitest-same");
    save({ name: "vitest-same-pal", colors: ["#112233"] }, "vitest-same");
    move("vitest-same-pal", "vitest-same", "vitest-same/");
    const names = list().items.filter((p) => p.folder === "vitest-same").map((p) => p.name);
    expect(names).toEqual(["vitest-same-pal"]);
    deleteFolder("vitest-same");
    remove("vitest-same-pal", "");
  });

  it("renameFolder rejects moving a folder into itself and missing sources", () => {
    createFolder("vitest-rf");
    expect(() => renameFolder("vitest-rf", "vitest-rf/child")).toThrow(/into itself/);
    expect(() => renameFolder("vitest-rf-missing", "vitest-rf-x")).toThrow(/not found/);
    expect(list().folders).toContain("vitest-rf");
    deleteFolder("vitest-rf");
  });
});
