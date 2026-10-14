import "server-only";
import { db } from "refr/server/db";
import type { Prisma } from "../../../generated/prisma";
import { invalidateTagVectors, invalidateAllTagVectors } from "./ml";

/** trim, collapse repeated '/', strip leading/trailing '/', lowercase. */
export function normalize(name: string): string {
  return name.trim().replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

export function ancestors(name: string): string[] {
  const parts = normalize(name).split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export type TagChange = { fileId: string; before: string[]; after: string[] };
export class TagUndoConflict extends Error {}

function invalidateTags(names: string[]) {
  invalidateTreeCache();
  const affected = new Set(names.flatMap((name) => ancestors(name)));
  return invalidateTagVectors([...affected]);
}

async function namesFor(tx: Prisma.TransactionClient, fileIds: string[]) {
  const links = await tx.fileTag.findMany({ where: { fileId: { in: fileIds } }, include: { tag: true } });
  const names = new Map(fileIds.map((id) => [id, [] as string[]]));
  for (const { fileId, tag } of links) names.get(fileId)?.push(tag.name);
  for (const values of names.values()) values.sort();
  return names;
}

async function getOrCreateTag(name: string): Promise<number> {
  const n = normalize(name);
  const row = await db.tag.upsert({ where: { name: n }, create: { name: n }, update: {} });
  return row.id;
}

/** Bulk add/remove tags on files. Adding a tag also removes its now-redundant
 *  ancestor tags from the affected files (a child implies its parents). */
export async function setTags(fileIds: string[], add: string[], remove: string[]) {
  if (fileIds.length === 0) return { changes: [] as TagChange[] };
  fileIds = [...new Set(fileIds)];
  const changes = await db.$transaction(async (tx) => {
    const before = await namesFor(tx, fileIds);
    for (const name of add) {
      const n = normalize(name);
      if (!n) continue;
      const tag = await tx.tag.upsert({ where: { name: n }, create: { name: n }, update: {} });
      // Limit bind parameters and skip only duplicate links; FK errors still
      // roll back the entire edit, including its undo snapshots.
      for (let i = 0; i < fileIds.length; i += 400) {
        const batch = fileIds.slice(i, i + 400);
        await tx.$executeRawUnsafe(
          `INSERT INTO FileTag (fileId, tagId) VALUES ${batch.map(() => "(?, ?)").join(",")}
           ON CONFLICT (fileId, tagId) DO NOTHING`,
          ...batch.flatMap((fileId) => [fileId, tag.id]),
        );
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
    const after = await namesFor(tx, fileIds);
    return [...before].flatMap(([fileId, tags]) => {
      const next = after.get(fileId)!;
      return JSON.stringify(tags) === JSON.stringify(next) ? [] : [{ fileId, before: tags, after: next }];
    });
  });
  if (changes.length) await invalidateTags(changes.flatMap((c) => [...c.before, ...c.after]));
  return { changes };
}

export async function undoTags(changes: TagChange[]): Promise<void> {
  if (!changes.length) return;
  await db.$transaction(async (tx) => {
    const current = await namesFor(tx, [...new Set(changes.map((c) => c.fileId))]);
    for (const change of changes) {
      if (JSON.stringify(current.get(change.fileId)) !== JSON.stringify([...change.after].sort())) {
        throw new TagUndoConflict(`Cannot undo tag change for ${change.fileId}: its tags have changed since the operation.`);
      }
    }
    for (const change of changes) {
      await tx.fileTag.deleteMany({ where: { fileId: change.fileId } });
      for (const name of change.before) {
        const tag = await tx.tag.upsert({ where: { name }, create: { name }, update: {} });
        await tx.fileTag.create({ data: { fileId: change.fileId, tagId: tag.id } });
      }
    }
  });
  await invalidateTags(changes.flatMap((c) => [...c.before, ...c.after]));
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
  await invalidateAllTagVectors();
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
  await invalidateAllTagVectors();
}

/** Delete a tag and all descendants. */
export async function deleteTag(name: string) {
  const n = normalize(name);
  await db.tag.deleteMany({ where: { OR: [{ name: n }, { name: { startsWith: n + "/" } }] } });
  invalidateTreeCache();
  await invalidateAllTagVectors();
}

export type TreeNode = { name: string; count: number };

let treeCache: { at: number; data: TreeNode[] } | null = null;
let treePending: Promise<TreeNode[]> | null = null;
let treeGeneration = 0;
const TREE_TTL = 5000;

/** Full tag list with counts including descendants, deduped per file. */
export async function tree(): Promise<TreeNode[]> {
  if (treeCache && Date.now() - treeCache.at < TREE_TTL) return treeCache.data;
  if (treePending) return treePending;
  const pending = loadTree(treeGeneration).finally(() => {
    if (treePending === pending) treePending = null;
  });
  treePending = pending;
  return pending;
}

async function loadTree(generation: number): Promise<TreeNode[]> {
  const rows = await db.$queryRaw<{ name: string; count: bigint }[]>`
    WITH RECURSIVE prefixes(tagId, name, prefix, rest) AS (
      SELECT id, name, '', name FROM Tag
      UNION ALL
      SELECT tagId, name,
        CASE WHEN prefix = '' THEN substr(rest, 1, instr(rest || '/', '/') - 1)
             ELSE prefix || '/' || substr(rest, 1, instr(rest || '/', '/') - 1) END,
        CASE WHEN instr(rest, '/') = 0 THEN '' ELSE substr(rest, instr(rest, '/') + 1) END
      FROM prefixes WHERE rest <> ''
    )
    SELECT p.prefix AS name, COUNT(DISTINCT ft.fileId) AS count
    FROM prefixes p JOIN FileTag ft ON ft.tagId = p.tagId
    WHERE p.prefix <> '' GROUP BY p.prefix ORDER BY p.prefix`;
  const data = rows.map(({ name, count }) => ({ name, count: Number(count) }));
  // A mutation may invalidate this load while its query is in flight.
  if (treeGeneration === generation) treeCache = { at: Date.now(), data };
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
  treePending = null;
  treeGeneration++;
}

export { getOrCreateTag };
