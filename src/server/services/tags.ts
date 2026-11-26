import "server-only";
import { db } from "refr/server/db";
import type { Prisma } from "../../../generated/prisma";
import { invalidateTagVectors, invalidateAllTagVectors } from "./ml";

import { ancestors, isUnder, normalize } from "refr/lib/tag-names";
import { matchTier } from "refr/lib/match";
import { expandImplications, resolveAlias, rewriteRuleTags } from "refr/lib/tag-rules";
import { getRules, updateRules } from "./tagRules";

export { ancestors, normalize };

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

/** Bulk add/remove tags on files. Added names go through the tag-rule aliases
 *  and pull in their implications (src/lib/tag-rules.ts). Adding a tag also
 *  removes its now-redundant ancestor tags from the affected files (a child
 *  implies its parents). */
export async function setTags(fileIds: string[], add: string[], remove: string[]) {
  const rules = getRules();
  const explicit = [...new Set(add.map((name) => resolveAlias(rules, name)).filter(Boolean))];
  // an implied tag that's an ancestor of an explicit one is already covered
  const implied = expandImplications(rules, explicit).filter((t) => !explicit.some((e) => isUnder(e, t)));
  return applyTags(fileIds, explicit, remove, implied);
}

/** `implied` tags are added only to files that don't already carry them or a
 *  descendant, so a rule never stacks a redundant parent onto a tagged file. */
async function applyTags(fileIds: string[], add: string[], remove: string[], implied: string[]) {
  if (fileIds.length === 0) return { changes: [] as TagChange[] };
  fileIds = [...new Set(fileIds)];
  const changes = await db.$transaction(async (tx) => {
    const before = await namesFor(tx, fileIds);
    for (const [names, onlyUncovered] of [[add, false], [implied, true]] as const) for (const name of names) {
      const n = normalize(name);
      if (!n) continue;
      const tag = await tx.tag.upsert({ where: { name: n }, create: { name: n }, update: {} });
      // Limit bind parameters and skip only duplicate links; FK errors still
      // roll back the entire edit, including its undo snapshots.
      for (let i = 0; i < fileIds.length; i += 400) {
        const batch = fileIds.slice(i, i + 400);
        if (onlyUncovered) {
          await tx.$executeRawUnsafe(
            `INSERT INTO FileTag (fileId, tagId)
             SELECT f.id, ? FROM File f WHERE f.id IN (${batch.map(() => "?").join(",")})
               AND NOT EXISTS (SELECT 1 FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
                               WHERE ft.fileId = f.id AND (t.name = ? OR t.name LIKE ? ESCAPE '\\'))
             ON CONFLICT (fileId, tagId) DO NOTHING`,
            tag.id, ...batch, n, escapeLike(n) + "/%",
          );
        } else {
          await tx.$executeRawUnsafe(
            `INSERT INTO FileTag (fileId, tagId) VALUES ${batch.map(() => "(?, ?)").join(",")}
             ON CONFLICT (fileId, tagId) DO NOTHING`,
            ...batch.flatMap((fileId) => [fileId, tag.id]),
          );
        }
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
  if (changes.length) {
    await dropFulfilledCandidates(changes);
    await invalidateTags(changes.flatMap((c) => [...c.before, ...c.after]));
  }
  return { changes };
}

/** A file that now carries a tag (or a descendant) is no longer that tag's
 *  inbox candidate — drop those rows now instead of waiting for the re-sweep. */
async function dropFulfilledCandidates(changes: TagChange[]) {
  for (const c of changes) {
    const names = [...new Set(c.after.flatMap((n) => ancestors(n)))];
    if (names.length) await db.tagCandidate.deleteMany({ where: { fileId: c.fileId, tag: { name: { in: names } } } });
  }
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

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** ✕ suggestion denials are keyed by tag *name* (any tree node, Tag row or
 *  not), so tag renames/merges must carry them along. `rewrite` maps an old
 *  name to its new name, or null to drop it. */
async function rewriteDenials(
  tx: Prisma.TransactionClient,
  names: { exact: string[]; prefix?: string },
  rewrite: (name: string) => string | null,
) {
  const clauses = names.exact.map(() => "tagName = ?");
  const params: string[] = [...names.exact];
  if (names.prefix) {
    clauses.push("tagName LIKE ? ESCAPE '\\'");
    params.push(escapeLike(names.prefix) + "/%");
  }
  if (clauses.length === 0) return;
  const where = clauses.join(" OR ");
  const rows = await tx.$queryRawUnsafe<{ tagName: string; fileId: string }[]>(
    `SELECT tagName, fileId FROM SuggestionDenial WHERE ${where}`, ...params,
  );
  await tx.$executeRawUnsafe(`DELETE FROM SuggestionDenial WHERE ${where}`, ...params);
  for (const r of rows) {
    const next = rewrite(r.tagName);
    if (next === null) continue;
    await tx.$executeRawUnsafe(
      `INSERT OR IGNORE INTO SuggestionDenial (tagName, fileId) VALUES (?, ?)`, next, r.fileId,
    );
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
    await rewriteDenials(tx, { exact: [from], prefix: from }, (name) => to + name.slice(from.length));
  });
  updateRules((rules) => rewriteRuleTags(rules, (name) => (isUnder(name, from) ? to + name.slice(from.length) : name)));
  invalidateTreeCache();
  await invalidateAllTagVectors();
}

/** Repoint all links from sources to target, dedupe, delete sources. */
export async function merge(sources: string[], target: string) {
  const to = normalize(target);
  if (!to) return;
  const srcNames = [...new Set(sources.map(normalize).filter((s) => s && s !== to))];
  await db.$transaction(async (tx) => {
    const targetTag = await tx.tag.upsert({ where: { name: to }, create: { name: to }, update: {} });
    // merge moves only the exact source tags' links, so only their denials
    await rewriteDenials(tx, { exact: srcNames }, () => to);
    for (const src of srcNames) {
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
  const merged = new Set(srcNames);
  updateRules((rules) => rewriteRuleTags(rules, (name) => (merged.has(name) ? to : name)));
  invalidateTreeCache();
  await invalidateAllTagVectors();
}

/** Delete a tag and all descendants. */
export async function deleteTag(name: string) {
  const n = normalize(name);
  if (!n) return;
  await db.$transaction(async (tx) => {
    await tx.tag.deleteMany({ where: { OR: [{ name: n }, { name: { startsWith: n + "/" } }] } });
    await rewriteDenials(tx, { exact: [n], prefix: n }, () => null);
  });
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

export type TagSuggestion = TreeNode & { /** the alias source that matched, for `fig → reference/figure` rows */ alias?: string };

/** Fuzzy autocomplete: substring match, exact → prefix/segment → mid-word, by
 *  count within each. Alias sources
 *  matching the term surface their target (exact alias hits first). */
export async function searchTags(term: string, limit = 20): Promise<TagSuggestion[]> {
  const t = normalize(term);
  const all = await tree();
  // exact, then prefix/segment-start matches, then mid-word substrings; by count within each
  // an alias row ranks by whichever of its name / alias matches better
  const tier = (r: TagSuggestion) =>
    Math.min(...[r.name, r.alias].filter((n) => n !== undefined).map((n) => {
      const k = matchTier(n, t);
      return k < 0 ? 3 : k;
    }));
  const byRank = (a: TagSuggestion, b: TagSuggestion) => tier(a) - tier(b) || b.count - a.count;
  const tags: TagSuggestion[] = all
    .filter((x) => x.name.includes(t))
    .sort(byRank)
    .slice(0, limit);
  const aliases = Object.entries(getRules().aliases).filter(([from]) => t && from.includes(t));
  if (aliases.length === 0) return tags;
  const counts = new Map(all.map((x) => [x.name, x.count]));
  // one row per target (TagInput keys rows by name), preferring an exact alias hit
  const byTarget = new Map<string, TagSuggestion>();
  for (const [alias, name] of aliases) {
    const prev = byTarget.get(name);
    if (!prev || alias === t) byTarget.set(name, { name, count: counts.get(name) ?? 0, alias });
  }
  const rows = [...tags.filter((x) => !byTarget.has(x.name)), ...byTarget.values()].sort(byRank);
  const exact = rows.filter((r) => r.alias === t);
  return [...exact, ...rows.filter((r) => r.alias !== t)].slice(0, limit);
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

/**
 * Apply the current tag rules to files tagged before the rules existed:
 * existing tags named by an alias source are renamed to the alias target (with
 * descendants), then every implication is backfilled onto files carrying its
 * tag or a descendant. Returns how many tags were renamed and files changed.
 */
export async function applyRulesToExisting(): Promise<{ renamedTags: number; changedFiles: number }> {
  let renamedTags = 0;
  for (const [from, to] of Object.entries(getRules().aliases)) {
    const n = await db.tag.count({ where: { OR: [{ name: from }, { name: { startsWith: from + "/" } }] } });
    if (n === 0) continue;
    await rename(from, to);
    renamedTags += n;
  }
  const rules = getRules();
  const changed = new Set<string>();
  for (const tag of Object.keys(rules.implications)) {
    const implied = expandImplications(rules, [tag]);
    let after = "";
    for (;;) {
      const rows = await db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT DISTINCT ft.fileId AS id FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
         WHERE (t.name = ? OR t.name LIKE ? ESCAPE '\\') AND ft.fileId > ?
         ORDER BY ft.fileId LIMIT 400`,
        tag, escapeLike(tag) + "/%", after,
      );
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.id;
      const { changes } = await applyTags(rows.map((r) => r.id), [], [], implied);
      for (const c of changes) changed.add(c.fileId);
    }
  }
  return { renamedTags, changedFiles: changed.size };
}

export function invalidateTreeCache() {
  treeCache = null;
  treePending = null;
  treeGeneration++;
}

export { getOrCreateTag };
