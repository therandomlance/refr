import "server-only";
import { db } from "refr/server/db";
import { excludeSuggestions, restoreSuggestions } from "./ml";
import { setTags, undoTags, type TagChange } from "./tags";
import { isSweepPending, requestSweep, sweepStatus } from "./sweep";
import { UNCERTAIN_FLOOR } from "refr/lib/tagging";

/** Tagging inbox queries over the sweep's TagCandidate cache.
 *  "ready" = confident (≥ min), no rival sibling, not near a rejected image. */

export type InboxTag = {
  tag: string;
  ready: number;
  flagged: number; // ≥ min but has a rival / is near a denial
  uncertain: number; // UNCERTAIN_FLOOR ≤ confidence < min
  top: number;
  positives: number;
};

export async function overview(minConfidence: number) {
  const rows = await db.$queryRawUnsafe<{
    tag: string; ready: bigint; flagged: bigint; uncertain: bigint; top: number; positives: number | null;
  }[]>(
    `SELECT t.name AS tag,
       SUM(CASE WHEN c.confidence >= ? AND c.rivalTag IS NULL AND c.nearDenial = 0 THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN c.confidence >= ? AND (c.rivalTag IS NOT NULL OR c.nearDenial = 1) THEN 1 ELSE 0 END) AS flagged,
       SUM(CASE WHEN c.confidence >= ? AND c.confidence < ? THEN 1 ELSE 0 END) AS uncertain,
       MAX(c.confidence) AS top, s.positives AS positives
     FROM TagCandidate c
     JOIN Tag t ON t.id = c.tagId
     LEFT JOIN TagSweep s ON s.tagId = c.tagId
     GROUP BY c.tagId
     HAVING ready > 0 OR flagged > 0 OR uncertain > 0
     ORDER BY ready DESC, top DESC, t.name`,
    minConfidence, minConfidence, UNCERTAIN_FLOOR, minConfidence,
  );
  const tags: InboxTag[] = rows.map((r) => ({
    tag: r.tag,
    ready: Number(r.ready),
    flagged: Number(r.flagged),
    uncertain: Number(r.uncertain),
    top: r.top,
    positives: r.positives === null ? 0 : Number(r.positives),
  }));
  return { tags, sweep: sweepStatus() };
}

export type Candidate = {
  fileId: string;
  confidence: number;
  mode: number;
  rival: { tag: string; confidence: number } | null;
  nearDenial: boolean;
  defaultState: "accept" | "skip";
  uncertain: boolean;
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** Next review batch for one tag, in diversified (rank) order. Files that gained
 *  the tag (or a descendant) or a ✕ since the sweep are filtered out live. */
export async function batch(input: {
  tag: string; minConfidence: number; size: number; includeUncertain: boolean; exclude: string[];
}) {
  const tag = await db.tag.findUnique({ where: { name: input.tag }, include: { sweep: true } });
  if (!tag) return { tag: input.tag, candidates: [] as Candidate[], exemplars: [] as string[][], positives: 0, modes: 0, sweeping: false };
  const floor = input.includeUncertain ? UNCERTAIN_FLOOR : input.minConfidence;
  const exclude = input.exclude.slice(0, 2000);
  const rows = await db.$queryRawUnsafe<{
    fileId: string; confidence: number; mode: number; rivalTag: string | null; rivalConfidence: number | null; nearDenial: number | boolean;
  }[]>(
    `SELECT c.fileId, c.confidence, c.mode, c.rivalTag, c.rivalConfidence, c.nearDenial
     FROM TagCandidate c
     WHERE c.tagId = ? AND c.confidence >= ?
       ${exclude.length ? `AND c.fileId NOT IN (${exclude.map(() => "?").join(",")})` : ""}
       AND NOT EXISTS (
         SELECT 1 FROM FileTag ft JOIN Tag t2 ON t2.id = ft.tagId
         WHERE ft.fileId = c.fileId AND (t2.name = ? OR t2.name LIKE ? ESCAPE '\\'))
       AND NOT EXISTS (SELECT 1 FROM SuggestionDenial d WHERE d.tagName = ? AND d.fileId = c.fileId)
     ORDER BY (c.confidence >= ?) DESC, c.rank
     LIMIT ?`,
    tag.id, floor, ...exclude, tag.name, escapeLike(tag.name) + "/%", tag.name, input.minConfidence, input.size,
  );
  const candidates: Candidate[] = rows.map((r) => {
    const nearDenial = r.nearDenial === true || r.nearDenial === 1;
    const rival = r.rivalTag ? { tag: r.rivalTag, confidence: r.rivalConfidence ?? 0 } : null;
    const uncertain = r.confidence < input.minConfidence;
    return {
      fileId: r.fileId,
      confidence: r.confidence,
      mode: r.mode,
      rival,
      nearDenial,
      uncertain,
      defaultState: uncertain || rival || nearDenial ? "skip" : "accept",
    };
  });
  let exemplars: string[][] = [];
  try {
    exemplars = tag.sweep ? (JSON.parse(tag.sweep.exemplars) as string[][]) : [];
  } catch {
    exemplars = [];
  }
  return {
    tag: tag.name,
    candidates,
    exemplars,
    positives: tag.sweep?.positives ?? 0,
    modes: tag.sweep?.modes ?? 0,
    sweeping: isSweepPending(tag.name),
  };
}

/** Recently added files with ready candidates, newest first (keyset on addedAt, id). */
export async function byFile(input: { minConfidence: number; cursor: string | null; limit: number }) {
  const ready = { confidence: { gte: input.minConfidence }, rivalTag: null, nearDenial: false };
  let after: { addedAt: Date; id: string } | null = null;
  if (input.cursor) {
    const sep = input.cursor.indexOf("|");
    after = { addedAt: new Date(Number(input.cursor.slice(0, sep))), id: input.cursor.slice(sep + 1) };
  }
  const files = await db.file.findMany({
    where: {
      candidates: { some: ready },
      ...(after ? { OR: [{ addedAt: { lt: after.addedAt } }, { addedAt: after.addedAt, id: { lt: after.id } }] } : {}),
    },
    orderBy: [{ addedAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: {
      id: true,
      addedAt: true,
      candidates: {
        where: ready,
        orderBy: { confidence: "desc" },
        take: 3,
        select: { confidence: true, tag: { select: { name: true } } },
      },
    },
  });
  const page = files.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((f) => ({ fileId: f.id, tags: f.candidates.map((c) => ({ tag: c.tag.name, confidence: c.confidence })) })),
    nextCursor: files.length > input.limit && last ? `${last.addedAt.getTime()}|${last.id}` : null,
  };
}

export type Denial = { tag: string; fileId: string };
export type CommitResult = { changes: TagChange[]; denied: Denial[] };

/** Collapse sequential edits of one file into a single before→after (undo needs one). */
function mergeChanges(changes: TagChange[]): TagChange[] {
  const out = new Map<string, TagChange>();
  for (const c of changes) {
    const prev = out.get(c.fileId);
    out.set(c.fileId, prev ? { fileId: c.fileId, before: prev.before, after: c.after } : c);
  }
  return [...out.values()].filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
}

/** Commit one tag's batch: accepts get the tag; rejects become ✕ denials (the
 *  classifier's negatives); reassigns get the other tag *and* a denial here. The
 *  touched tags' caches invalidate, which queues their retrain + re-sweep. */
export async function commit(input: {
  tag: string; accept: string[]; deny: string[]; reassign: { tag: string; fileIds: string[] }[];
}): Promise<CommitResult> {
  const changes: TagChange[] = [];
  if (input.accept.length) changes.push(...(await setTags(input.accept, [input.tag], [])).changes);
  const deny = new Set(input.deny);
  for (const r of input.reassign) {
    if (!r.fileIds.length) continue;
    changes.push(...(await setTags(r.fileIds, [r.tag], [])).changes);
    for (const id of r.fileIds) deny.add(id);
  }
  const denied = (await excludeSuggestions(input.tag, [...deny])).map((fileId) => ({ tag: input.tag, fileId }));
  requestSweep({ tags: [input.tag, ...input.reassign.map((r) => r.tag)] });
  return { changes: mergeChanges(changes), denied };
}

/** By-file commit: per file, tags to accept and tags to reject. */
export async function commitFiles(items: { fileId: string; accept: string[]; deny: string[] }[]): Promise<CommitResult> {
  const acceptBy = new Map<string, string[]>();
  const denyBy = new Map<string, string[]>();
  for (const it of items) {
    for (const t of it.accept) acceptBy.set(t, [...(acceptBy.get(t) ?? []), it.fileId]);
    for (const t of it.deny) denyBy.set(t, [...(denyBy.get(t) ?? []), it.fileId]);
  }
  const changes: TagChange[] = [];
  for (const [tag, ids] of acceptBy) changes.push(...(await setTags(ids, [tag], [])).changes);
  const denied: Denial[] = [];
  for (const [tag, ids] of denyBy) denied.push(...(await excludeSuggestions(tag, ids)).map((fileId) => ({ tag, fileId })));
  requestSweep({ tags: [...acceptBy.keys(), ...denyBy.keys()] });
  return { changes: mergeChanges(changes), denied };
}

export async function undo(result: CommitResult) {
  await undoTags(result.changes);
  await restoreSuggestions(result.denied);
}
