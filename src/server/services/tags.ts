import "server-only";
import { db } from "refr/server/db";
import { bumpLinksVersion } from "./ml";

/** trim, collapse repeated '/', strip leading/trailing '/', lowercase. */
export function normalize(name: string): string {
  return name.trim().replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

export function ancestors(name: string): string[] {
  const parts = normalize(name).split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

async function getOrCreateTag(name: string): Promise<number> {
  const n = normalize(name);
  const row = await db.tag.upsert({ where: { name: n }, create: { name: n }, update: {} });
  return row.id;
}

/** Bulk add/remove tags on files. Adding a tag also removes its now-redundant
 *  ancestor tags from the affected files (a child implies its parents). */
export async function setTags(fileIds: string[], add: string[], remove: string[]) {
  if (fileIds.length === 0) return;
  await db.$transaction(async (tx) => {
    for (const name of add) {
      const n = normalize(name);
      if (!n) continue;
      const tag = await tx.tag.upsert({ where: { name: n }, create: { name: n }, update: {} });
      for (const fileId of fileIds) {
        await tx.fileTag.upsert({
          where: { fileId_tagId: { fileId, tagId: tag.id } },
          create: { fileId, tagId: tag.id },
          update: {},
        });
      }
      // the new tag implies its ancestors — remove explicit ancestor links
      for (const ancestor of ancestors(n).slice(0, -1)) {
        await tx.fileTag.deleteMany({
          where: { fileId: { in: fileIds }, tag: { name: ancestor } },
        });
      }
    }
    for (const name of remove) {
      const n = normalize(name);
      await tx.fileTag.deleteMany({
        where: { fileId: { in: fileIds }, tag: { name: n } },
      });
    }
  });
  if (add.length || remove.length) {
    invalidateTreeCache();
    await bumpLinksVersion();
  }
}

/** Rename a tag and rewrite every descendant. Merges collisions. */
export async function rename(oldName: string, newName: string) {
  const from = normalize(oldName);
  const to = normalize(newName);
  if (!from || !to || from === to) return;
  await db.$transaction(async (tx) => {
    const affected = await tx.tag.findMany({
      where: { OR: [{ name: from }, { name: { startsWith: from + "/" } }] },
    });
    for (const tag of affected) {
      const suffix = tag.name.slice(from.length); // "" or "/..."
      const target = to + suffix;
      const existing = await tx.tag.findUnique({ where: { name: target } });
      if (existing) {
        // collision: move links to existing tag, dedupe, delete old tag
        const links = await tx.fileTag.findMany({ where: { tagId: tag.id } });
        for (const link of links) {
          await tx.fileTag.upsert({
            where: { fileId_tagId: { fileId: link.fileId, tagId: existing.id } },
            create: { fileId: link.fileId, tagId: existing.id },
            update: {},
          });
        }
        await tx.fileTag.deleteMany({ where: { tagId: tag.id } });
        await tx.tag.delete({ where: { id: tag.id } });
      } else {
        await tx.tag.update({ where: { id: tag.id }, data: { name: target } });
      }
    }
  });
  invalidateTreeCache();
  await bumpLinksVersion();
}

/** Repoint all links from sources to target, dedupe, delete sources. */
export async function merge(sources: string[], target: string) {
  const to = normalize(target);
  if (!to) return;
  await db.$transaction(async (tx) => {
    const targetTag = await tx.tag.upsert({ where: { name: to }, create: { name: to }, update: {} });
    for (const src of sources.map(normalize).filter((s) => s && s !== to)) {
      const tag = await tx.tag.findUnique({ where: { name: src } });
      if (!tag) continue;
      const links = await tx.fileTag.findMany({ where: { tagId: tag.id } });
      for (const link of links) {
        await tx.fileTag.upsert({
          where: { fileId_tagId: { fileId: link.fileId, tagId: targetTag.id } },
          create: { fileId: link.fileId, tagId: targetTag.id },
          update: {},
        });
      }
      await tx.tag.delete({ where: { id: tag.id } }); // links cascade
    }
  });
  invalidateTreeCache();
  await bumpLinksVersion();
}

/** Delete a tag and all descendants. */
export async function deleteTag(name: string) {
  const n = normalize(name);
  await db.tag.deleteMany({ where: { OR: [{ name: n }, { name: { startsWith: n + "/" } }] } });
  invalidateTreeCache();
  await bumpLinksVersion();
}

export type TreeNode = { name: string; count: number };

let treeCache: { at: number; data: TreeNode[] } | null = null;
const TREE_TTL = 5000;

/** Full tag list with counts including descendants, deduped per file. */
export async function tree(): Promise<TreeNode[]> {
  if (treeCache && Date.now() - treeCache.at < TREE_TTL) return treeCache.data;
  const links = await db.fileTag.findMany({
    select: { fileId: true, tag: { select: { name: true } } },
  });
  const counts = new Map<string, Set<string>>();
  for (const l of links) {
    for (const prefix of ancestors(l.tag.name)) {
      let set = counts.get(prefix);
      if (!set) counts.set(prefix, (set = new Set()));
      set.add(l.fileId);
    }
  }
  const data = [...counts.entries()]
    .map(([name, set]) => ({ name, count: set.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
  treeCache = { at: Date.now(), data };
  return data;
}

/** Fuzzy autocomplete: substring match ordered by count desc. */
export async function searchTags(term: string, limit = 20): Promise<TreeNode[]> {
  const t = normalize(term);
  const all = await tree();
  return all
    .filter((x) => x.name.includes(t))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Intersection of tags across files (for viewer/multi-select). */
export async function forFiles(fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const groups = await db.fileTag.groupBy({
    by: ["tagId"],
    where: { fileId: { in: fileIds } },
    _count: { fileId: true },
  });
  const common = groups.filter((g) => g._count.fileId === fileIds.length).map((g) => g.tagId);
  const tags = await db.tag.findMany({ where: { id: { in: common } }, select: { name: true } });
  return tags.map((t) => t.name).sort();
}

export function invalidateTreeCache() {
  treeCache = null;
}

export { getOrCreateTag };
