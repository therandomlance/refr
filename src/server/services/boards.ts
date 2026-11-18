import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "./dataDir";
import { listJson, readJson, safeName, writeJson } from "./jsonStore";
import { db } from "refr/server/db";
import { BOARD_GAP, BOARD_ITEM_WIDTH, boardSchema, type Board, type ImageItem } from "refr/lib/boards";

/** Moodboards: one plaintext JSON file per board in data/boards/. */

const fileFor = (name: string) => path.join(paths.boards, safeName(name) + ".json");

export function list(): { name: string; count: number; mtime: number }[] {
  return listJson(paths.boards)
    .map((name) => {
      const file = path.join(paths.boards, name + ".json");
      const board = readJson(file, boardSchema);
      const count = board?.items.filter((i) => i.kind === "image").length ?? 0;
      return { name, count, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function get(name: string): Board {
  const board = readJson(fileFor(name), boardSchema);
  if (!board) throw new Error(`board '${name}' not found`);
  return board;
}

/** Whole-document setter (the canvas autosaves its full state). */
export function save(name: string, board: Board) {
  if (!fs.existsSync(fileFor(name))) throw new Error(`board '${name}' not found`);
  writeJson(fileFor(name), boardSchema.parse(board));
}

/** Returns the stored (filename-safe) name. */
export function create(name: string): string {
  const file = fileFor(name);
  if (fs.existsSync(file)) throw new Error(`a board named '${safeName(name)}' already exists`);
  writeJson(file, boardSchema.parse({}));
  return safeName(name);
}

export function rename(from: string, to: string): string {
  const src = fileFor(from);
  const dst = fileFor(to);
  if (!fs.existsSync(src)) throw new Error(`board '${from}' not found`);
  if (src !== dst && fs.existsSync(dst)) throw new Error(`a board named '${safeName(to)}' already exists`);
  fs.renameSync(src, dst);
  return safeName(to);
}

export function remove(name: string) {
  fs.rmSync(fileFor(name), { force: true });
}

/**
 * Append files as a row to the right of the existing content, top-aligned with
 * it. Files already on the board are skipped. Returns how many were added.
 * ponytail: read-modify-write without locking — a canvas autosave racing this
 * (same board open in another tab) can drop one side's change.
 */
export async function addFiles(name: string, fileIds: string[]): Promise<{ added: number; skipped: number }> {
  const board = get(name);
  const onBoard = new Set(board.items.flatMap((i) => (i.kind === "image" ? [i.fileId] : [])));
  const fresh = [...new Set(fileIds)].filter((id) => !onBoard.has(id));
  const known = new Set(
    (await db.file.findMany({ where: { id: { in: fresh } }, select: { id: true } })).map((f) => f.id),
  );
  const toAdd = fresh.filter((id) => known.has(id));
  let x = board.items.length ? Math.max(...board.items.map((i) => i.x + i.w)) + BOARD_GAP : 0;
  const y = board.items.length ? Math.min(...board.items.map((i) => i.y)) : 0;
  const items: ImageItem[] = toAdd.map((fileId) => {
    const item: ImageItem = { kind: "image", id: crypto.randomUUID(), fileId, x, y, w: BOARD_ITEM_WIDTH, rot: 0, flipX: false };
    x += BOARD_ITEM_WIDTH + BOARD_GAP;
    return item;
  });
  writeJson(fileFor(name), { ...board, items: [...board.items, ...items] });
  return { added: items.length, skipped: fileIds.length - items.length };
}
