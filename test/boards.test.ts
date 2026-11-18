import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import * as boards from "refr/server/services/boards";
import { paths } from "refr/server/services/dataDir";
import { BOARD_GAP, BOARD_ITEM_WIDTH } from "refr/lib/boards";

describe("boards service", () => {
  it("setup files", async () => {
    for (const id of ["bd1", "bd2", "bd3"]) {
      await db.file.create({ data: { id, size: 1, mtime: new Date(), mediaType: "image", width: 800, height: 600 } });
    }
  });

  it("create → empty board on disk; duplicate names rejected", () => {
    expect(boards.create("Figure studies")).toBe("Figure studies");
    expect(fs.existsSync(path.join(paths.boards, "Figure studies.json"))).toBe(true);
    expect(boards.get("Figure studies")).toEqual({ items: [], arrows: [], hidden: [] });
    expect(() => boards.create("Figure studies")).toThrow(/already exists/);
  });

  it("sanitises names into safe filenames", () => {
    expect(boards.create("a/b:c")).toBe("a_b_c");
    expect(boards.list().map((b) => b.name)).toContain("a_b_c");
    boards.remove("a_b_c");
  });

  it("addFiles appends a row, skips duplicates and unknown ids", async () => {
    expect(await boards.addFiles("Figure studies", ["bd1", "bd2"])).toEqual({ added: 2, skipped: 0 });
    const b = boards.get("Figure studies");
    expect(b.items.map((i) => [i.kind === "image" && i.fileId, i.x, i.y, i.w])).toEqual([
      ["bd1", 0, 0, BOARD_ITEM_WIDTH],
      ["bd2", BOARD_ITEM_WIDTH + BOARD_GAP, 0, BOARD_ITEM_WIDTH],
    ]);
    expect(await boards.addFiles("Figure studies", ["bd2", "bd3", "nope"])).toEqual({ added: 1, skipped: 2 });
    const after = boards.get("Figure studies").items;
    expect(after.map((i) => i.kind === "image" && i.fileId)).toEqual(["bd1", "bd2", "bd3"]);
    // new row continues to the right of existing content
    expect(after[2]!.x).toBe(2 * (BOARD_ITEM_WIDTH + BOARD_GAP));
    expect(boards.list().find((x) => x.name === "Figure studies")?.count).toBe(3);
  });

  it("save round-trips the whole document", () => {
    const b = boards.get("Figure studies");
    const img = b.items[1]!;
    if (img.kind !== "image") throw new Error("expected image");
    const edited = {
      items: [
        { ...img, x: -50, rot: 30, flipX: true, study: { gray: true, blur: false, value: 3 as const, grid: "thirds" as const } },
        b.items[0]!,
        { kind: "text" as const, id: "t1", x: 0, y: 500, w: 200, h: 80, text: "**hi**", size: "m" as const, color: "accent" as const, bg: "card" as const, align: "left" as const },
      ],
      arrows: [{ id: "a1", from: { item: "t1" }, to: { x: 10, y: 20 }, color: "fg" as const, width: "m" as const, heads: "end" as const, dashed: false }],
      hidden: ["bd3"],
    };
    boards.save("Figure studies", edited);
    expect(boards.get("Figure studies")).toEqual(edited);
    expect(boards.list().find((x) => x.name === "Figure studies")?.hidden).toBe(1);
    boards.resetHidden("Figure studies");
    expect(boards.get("Figure studies")).toEqual({ ...edited, hidden: [] });
    expect(() => boards.save("no such board", edited)).toThrow(/not found/);
  });

  it("rename and delete", () => {
    boards.create("Other");
    expect(() => boards.rename("Figure studies", "Other")).toThrow(/already exists/);
    expect(boards.rename("Figure studies", "Gestures")).toBe("Gestures");
    expect(() => boards.get("Figure studies")).toThrow(/not found/);
    expect(boards.get("Gestures").items).toHaveLength(3);
    expect(boards.list().find((x) => x.name === "Gestures")?.count).toBe(2); // images only
    boards.remove("Gestures");
    boards.remove("Other");
    expect(boards.list().map((b) => b.name)).not.toContain("Gestures");
  });
});

describe("board schema migration", () => {
  it("reads pre-text boards: items default to images, view is dropped", async () => {
    const { boardSchema } = await import("refr/lib/boards");
    const old = { items: [{ id: "i", fileId: "f", x: 1, y: 2, w: 300, rot: 0, flipX: false }], view: { x: 0, y: 0, zoom: 1 } };
    expect(boardSchema.parse(old)).toEqual({
      items: [{ kind: "image", id: "i", fileId: "f", x: 1, y: 2, w: 300, rot: 0, flipX: false }],
      arrows: [],
      hidden: [],
    });
  });
});
