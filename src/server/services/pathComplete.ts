import "server-only";
import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { db } from "refr/server/db";
import { matchTier } from "refr/lib/match";

export type PathLib = { root: string; alias?: string };
export type PathRow = { name: string; count?: number };

const LIMIT = 20;

/** Directory names in `dir` whose name starts with `partial`. */
async function dirSuggestions(dir: string, partial: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(partial.toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Split a full path into its existing parent dir + trailing partial segment. */
async function resolveDir(full: string): Promise<{ dir: string; partial: string }> {
  try {
    const st = await fsp.stat(full);
    if (st.isDirectory()) return { dir: full, partial: "" };
  } catch {
    // doesn't exist yet — treat the last segment as a partial name
  }
  const i = full.lastIndexOf("/");
  return { dir: i <= 0 ? "/" : full.slice(0, i), partial: full.slice(i + 1) };
}

/** `path:` value for a folder: alias form for aliased libraries, else absolute. */
function displayFor(lib: PathLib, dir: string): string {
  if (!lib.alias) return dir;
  const r = path.relative(lib.root, dir);
  return r ? `${lib.alias}/${r}` : lib.alias;
}

// ---------------------------------------------------------------- folder index

type Folder = { name: string; key: string; count: number };
type Index = { sig: string; at: number; folders: Folder[]; byName: Map<string, Folder> };

const TTL_MS = 60_000;
let index: Index | null = null;
let building: Promise<Index> | null = null;

/** Every folder (and its ancestors up to the library root) that holds indexed
 *  files, with recursive path counts. Built from FilePath, so it lists what a
 *  `path:` chip can actually find, without walking the disk.
 *  ponytail: rebuilt at most once a minute (stale results are served while it
 *  rebuilds) rather than invalidated by the scanner; counts are FilePath rows,
 *  so a file stored twice under one folder counts twice. */
async function buildIndex(libs: PathLib[], sig: string): Promise<Index> {
  // rtrim(path, <every non-slash char of path>) strips the file name → "<dir>/"
  const rows = await db.$queryRawUnsafe<{ dir: string; c: bigint | number }[]>(
    `SELECT rtrim(path, replace(path, '/', '')) AS dir, COUNT(*) AS c FROM FilePath GROUP BY dir`,
  );
  const counts = new Map<string, { lib: PathLib; count: number }>();
  for (const r of rows) {
    const dir = r.dir.replace(/\/+$/, "");
    const lib = libs.find((l) => dir === l.root || dir.startsWith(l.root + "/"));
    if (!lib) continue;
    // credit the folder and each ancestor up to (and including) the root
    for (let d = dir; ; d = path.dirname(d)) {
      const prev = counts.get(d);
      counts.set(d, { lib, count: (prev?.count ?? 0) + Number(r.c) });
      if (d === lib.root || d.length <= lib.root.length) break;
    }
  }
  const folders: Folder[] = [...counts].map(([dir, { lib, count }]) => {
    const rel = path.relative(lib.root, dir);
    const head = lib.alias ?? path.basename(lib.root);
    return { name: displayFor(lib, dir), key: rel ? `${head}/${rel}` : head, count };
  });
  return { sig, at: Date.now(), folders, byName: new Map(folders.map((f) => [f.name, f])) };
}

async function folderIndex(libs: PathLib[]): Promise<Index> {
  const sig = JSON.stringify(libs);
  if (index?.sig === sig && Date.now() - index.at < TTL_MS) return index;
  building ??= buildIndex(libs, sig).then((i) => (index = i)).finally(() => { building = null; });
  // same libraries, just stale → answer from the old index while rebuilding
  if (index?.sig === sig) return index;
  return building;
}

/** Test hook: drop the cached folder index. */
export function resetFolderIndex() {
  index = null;
}

/** Folders whose `alias/rel` (or `libname/rel`) contains `term` — ranked like
 *  tags: prefix/segment matches first, then by file count. */
function fuzzy(idx: Index, term: string): Folder[] {
  return idx.folders
    .map((f) => ({ f, r: matchTier(f.key, term) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || b.f.count - a.f.count || a.f.name.length - b.f.name.length)
    .map((x) => x.f);
}

// ---------------------------------------------------------------- completion

/** Exact navigation rows: alias/absolute prefix → that folder, then its
 *  subfolders from disk (so unscanned folders still complete). */
async function navigate(typed: string, libs: PathLib[]): Promise<string[]> {
  const slash = typed.indexOf("/");
  const head = slash === -1 ? typed : typed.slice(0, slash);
  const aliasLib = libs.find((l) => l.alias?.toLowerCase() === head.toLowerCase());

  if (aliasLib) {
    const rest = slash === -1 ? "" : typed.slice(slash + 1);
    const full = rest ? path.join(aliasLib.root, rest) : aliasLib.root;
    const { dir, partial } = await resolveDir(full);
    // an existing folder lists itself first, so Enter on a complete path
    // commits that folder instead of its first subfolder
    const self = partial === "" ? [displayFor(aliasLib, path.resolve(dir))] : [];
    const kids = (await dirSuggestions(dir, partial)).map((n) => displayFor(aliasLib, path.join(dir, n)));
    return [...self, ...kids];
  }

  if (typed.startsWith("/")) {
    const t = path.normalize(typed);
    const lib = libs.find((l) => l.root === t.replace(/\/+$/, "") || t.startsWith(l.root + "/"));
    if (lib) {
      const { dir, partial } = await resolveDir(t);
      const self = partial === "" ? [path.resolve(dir)] : [];
      return [...self, ...(await dirSuggestions(dir, partial)).map((n) => path.join(dir, n))];
    }
    return libs.map((l) => l.root).filter((r) => r.startsWith(t));
  }

  // partial alias (no slash) — listed even when the library has no files yet
  return libs
    .filter((l) => l.alias?.toLowerCase().startsWith(typed.toLowerCase()))
    .map((l) => l.alias!);
}

/** `path:` autocomplete: aliases/roots, exact folder navigation, then fuzzy
 *  substring matches over every indexed folder. Alias-form rows stay in alias
 *  form so the chip keeps working if the library moves. */
export async function pathComplete(typed: string, libs: PathLib[]): Promise<PathRow[]> {
  const idx = await folderIndex(libs);
  const withCount = (name: string): PathRow => {
    const count = idx.byName.get(name)?.count;
    return count === undefined ? { name } : { name, count };
  };
  if (!typed) return libs.map((l) => withCount(l.alias ?? l.root)).slice(0, LIMIT);

  const names = new Set(await navigate(typed, libs));
  if (!typed.startsWith("/")) {
    for (const f of fuzzy(idx, typed)) {
      if (names.size >= LIMIT) break;
      names.add(f.name);
    }
  }
  return [...names].slice(0, LIMIT).map(withCount);
}
