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
    expect(boards.get("Figure studies")).toEqual({ items: [], view: { x: 0, y: 0, zoom: 1 } });
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
    expect(b.items.map((i) => [i.fileId, i.x, i.y, i.w])).toEqual([
      ["bd1", 0, 0, BOARD_ITEM_WIDTH],
      ["bd2", BOARD_ITEM_WIDTH + BOARD_GAP, 0, BOARD_ITEM_WIDTH],
    ]);
    expect(await boards.addFiles("Figure studies", ["bd2", "bd3", "nope"])).toEqual({ added: 1, skipped: 2 });
    const after = boards.get("Figure studies").items;
    expect(after.map((i) => i.fileId)).toEqual(["bd1", "bd2", "bd3"]);
    // new row continues to the right of existing content
    expect(after[2]!.x).toBe(2 * (BOARD_ITEM_WIDTH + BOARD_GAP));
    expect(boards.list().find((x) => x.name === "Figure studies")?.count).toBe(3);
  });

  it("save round-trips the whole document", () => {
    const b = boards.get("Figure studies");
    const edited = { items: [{ ...b.items[1]!, x: -50, rot: 30, flipX: true }, b.items[0]!], view: { x: 12, y: -4, zoom: 0.5 } };
    boards.save("Figure studies", edited);
    expect(boards.get("Figure studies")).toEqual(edited);
    expect(() => boards.save("no such board", edited)).toThrow(/not found/);
  });

  it("rename and delete", () => {
    boards.create("Other");
    expect(() => boards.rename("Figure studies", "Other")).toThrow(/already exists/);
    expect(boards.rename("Figure studies", "Gestures")).toBe("Gestures");
    expect(() => boards.get("Figure studies")).toThrow(/not found/);
    expect(boards.get("Gestures").items).toHaveLength(2);
    boards.remove("Gestures");
    boards.remove("Other");
    expect(boards.list().map((b) => b.name)).not.toContain("Gestures");
  });
});
