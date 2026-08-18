import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as config from "refr/server/services/config";
import { tree as tagTreeService } from "refr/server/services/tags";
import { EXTENSIONS } from "refr/server/services/scanner";

export type FolderNode = { name: string; path: string; hasChildren: boolean };

async function childrenOf(dir: string): Promise<FolderNode[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FolderNode[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    out.push({ name: e.name, path: full, hasChildren: await hasMediaOrSubdirs(full) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Directory counts as a child if it (or a descendant, shallow check) has dirs or media files. */
async function hasMediaOrSubdirs(dir: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.some(
      (e) =>
        e.isDirectory() ||
        (e.isFile() && path.extname(e.name).slice(1).toLowerCase() in EXTENSIONS),
    );
  } catch {
    return false;
  }
}

export const browseRouter = createTRPCRouter({
  /** Top level = configured libraries. */
  folderTree: protectedProcedure.query(async (): Promise<FolderNode[]> => {
    const libs = config.get().libraries.map((l) => path.resolve(l));
    const out: FolderNode[] = [];
    for (const lib of libs) {
      if (fs.existsSync(lib)) {
        out.push({ name: path.basename(lib) || lib, path: lib, hasChildren: await hasMediaOrSubdirs(lib) });
      }
    }
    return out;
  }),

  children: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(({ input }) => childrenOf(input.path)),

  /** Tag tree with counts incl. descendants; empty tags hidden client-side. */
  tagTree: protectedProcedure.query(() => tagTreeService()),
});
