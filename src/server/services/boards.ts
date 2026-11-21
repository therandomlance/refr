import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "./dataDir";
import { listJson, readJson, safeName, writeJson } from "./jsonStore";
import { db } from "refr/server/db";
import { z } from "zod";
import { BOARD_GAP, BOARD_ITEM_WIDTH, boardSchema, type Board, type BoardTreeNode, type ImageItem } from "refr/lib/boards";
import {
  addFolder,
  deleteFolderIn,
  filterLeaves,
  findLeaf,
  leaves,
  moveNode,
  renameFolderIn,
} from "refr/lib/folder-tree";

/**
 * Moodboards: one plaintext JSON file per board in data/boards/. Sidebar
 * folders and order live separately in data/boards.json; the board files are
 * the source of truth for which boards exist (see `tree()`).
 */

const fileFor = (name: string) => path.join(paths.boards, safeName(name) + ".json");

export function list(): { name: string; count: number; hidden: number; mtime: number }[] {
  return listJson(paths.boards)
    .map((name) => {
      const file = path.join(paths.boards, name + ".json");
      const board = readJson(file, boardSchema);
      const count = board?.items.filter((i) => i.kind === "image").length ?? 0;
      return { name, count, hidden: board?.hidden.length ?? 0, mtime: fs.statSync(file).mtimeMs };
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
  // read the tree while the old file still exists, so the entry keeps its place
  const items = tree();
  fs.renameSync(src, dst);
  const stored = safeName(to);
  const leaf = findLeaf(items, safeName(from));
  if (leaf && leaf.name !== stored) {
    leaf.name = stored;
    persistTree(items);
  }
  return stored;
}

/** Clear the board's hidden-suggestions list. */
export function resetHidden(name: string) {
  writeJson(fileFor(name), { ...get(name), hidden: [] });
}

export function remove(name: string) {
  fs.rmSync(fileFor(name), { force: true });
  persistTree(tree()); // tree() already drops the missing board
}

// ---------------------------------------------------------------- sidebar tree

const leafSchema = z.object({ t: z.literal("board"), name: z.string().min(1) });
const treeNodeSchema: z.ZodType<BoardTreeNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([z.object({ t: z.literal("folder"), name: z.string().min(1), children: z.array(treeNodeSchema) }), leafSchema]),
);
const treeStoreSchema = z.object({ items: z.array(treeNodeSchema) });

/**
 * The stored tree reconciled with the board files: entries whose file is gone
 * are dropped, and boards missing from the tree (new, or pre-folder installs)
 * are appended to the root, most recently changed first.
 */
export function tree(): BoardTreeNode[] {
  const onDisk = list();
  const exists = new Set(onDisk.map((b) => b.name));
  const items = filterLeaves(readJson(paths.boardsIndex, treeStoreSchema)?.items ?? [], (b) => exists.has(b.name));
  const placed = new Set(leaves(items).map((b) => b.name));
  for (const b of onDisk) if (!placed.has(b.name)) items.push({ t: "board", name: b.name });
  return items;
}

function persistTree(items: BoardTreeNode[]) {
  writeJson(paths.boardsIndex, { items });
}

export function createFolder(name: string, parent: string | null) {
  const items = tree();
  if (addFolder(items, name, parent)) persistTree(items);
}

export function renameFolder(folderPath: string, newName: string) {
  const items = tree();
  if (renameFolderIn(items, folderPath, newName)) persistTree(items);
}

export function deleteFolder(folderPath: string) {
  const items = tree();
  if (deleteFolderIn(items, folderPath)) persistTree(items);
}

export function move(key: string, parent: string | null, beforeKey: string | null) {
  persistTree(moveNode(tree(), key, parent, beforeKey));
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
