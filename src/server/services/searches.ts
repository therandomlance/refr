import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "./dataDir";
import { readJson, writeJson } from "./jsonStore";
import { tokenSchema } from "./search";
import type { SavedFolderNode, SavedNode, SavedSearchNode } from "refr/lib/saved-searches";
import {
  addFolder,
  deleteFolderIn,
  filterLeaves,
  findLeaf,
  moveNode,
  renameFolderIn,
} from "refr/lib/folder-tree";

/**
 * Saved searches in a nested folder tree, stored as one ordered file at
 * `data/searches.json`. Order and folder membership live here so drag/reorder
 * is a read-modify-write. Legacy per-file `data/searches/*.json` are imported
 * on first read (and rewritten to the new file on the next write).
 */

const sortEnum = z.enum(["date", "name", "size", "random", "similarity"]);

const searchNodeSchema = z.object({
  t: z.literal("search"),
  name: z.string().min(1),
  tokens: z.array(tokenSchema),
  sort: sortEnum.optional(),
});
const folderNodeSchema = z.lazy(() =>
  z.object({ t: z.literal("folder"), name: z.string().min(1), children: z.array(nodeSchema) }),
);
const nodeSchema: z.ZodType<SavedNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([folderNodeSchema, searchNodeSchema]),
);
const storeSchema = z.object({ items: z.array(nodeSchema) });
const legacySchema = z.object({
  name: z.string().min(1),
  tokens: z.array(tokenSchema),
  sort: sortEnum.optional(),
});

export type SavedSearch = SavedSearchNode;
export type SavedFolder = SavedFolderNode;

export function list(): SavedNode[] {
  const stored = readJson(paths.searchesIndex, storeSchema);
  if (stored) return stored.items;
  return migrateLegacy();
}

function migrateLegacy(): SavedNode[] {
  if (!fs.existsSync(paths.searches)) return [];
  return fs
    .readdirSync(paths.searches)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(paths.searches, f), legacySchema))
    .filter((s): s is z.infer<typeof legacySchema> => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s): SavedSearchNode => ({ t: "search", name: s.name, tokens: s.tokens, ...(s.sort ? { sort: s.sort } : {}) }));
}

function persist(items: SavedNode[]) {
  writeJson(paths.searchesIndex, { items });
}

// ---------------------------------------------------------------- search ops

export function save(name: string, tokens: SavedSearchNode["tokens"], sort?: SavedSearchNode["sort"]) {
  const items = list();
  const existing = findSearch(items, name);
  if (existing) {
    existing.tokens = tokens;
    if (sort) existing.sort = sort;
    else delete existing.sort;
  } else {
    items.push({ t: "search", name, tokens, ...(sort ? { sort } : {}) });
  }
  persist(items);
}

export function remove(name: string) {
  persist(filterSearches(list(), name));
}

export function rename(oldName: string, newName: string) {
  if (oldName === newName) return;
  // a name clash overwrites the target, matching the old per-file behavior
  const items = filterSearches(list(), newName);
  const target = findSearch(items, oldName);
  if (target) target.name = newName;
  persist(items);
}

// ---------------------------------------------------------------- folder ops

export function createFolder(name: string, parent: string | null) {
  const items = list();
  if (addFolder(items, name, parent)) persist(items);
}

export function renameFolder(folderPath: string, newName: string) {
  const items = list();
  if (renameFolderIn(items, folderPath, newName)) persist(items);
}

export function deleteFolder(folderPath: string) {
  const items = list();
  if (deleteFolderIn(items, folderPath)) persist(items);
}

// ---------------------------------------------------------------- ordering

export function move(key: string, parent: string | null, beforeKey: string | null) {
  persist(moveNode(list(), key, parent, beforeKey));
}

// ---------------------------------------------------------------- helpers

const filterSearches = (items: SavedNode[], name: string) => filterLeaves(items, (s) => s.name !== name);
const findSearch = (items: SavedNode[], name: string) => findLeaf(items, name);
