import "server-only";
import { z } from "zod";
import { db } from "refr/server/db";
import type { TimelineBucket } from "refr/lib/timeline";
import * as config from "./config";
import { getRules } from "./tagRules";
import { resolveAlias } from "refr/lib/tag-rules";
import {
  escapeLike,
  fpUnderSql,
  SUMMARY_COLS,
  buildListQuery,
  nextCursorFor,
  PAGE_SIZE,
  pathUnderSql,
  type FileSummary,
  type ListResult,
  type Sort,
} from "./search";

type Sql = { text: string; params: unknown[] };

export const timelineMonthSchema = z.object({
  year: z.number().int().min(1).max(9999),
  month: z.number().int().min(1).max(12),
});

/** undefined = unrestricted; [] = no enabled libraries. */
export function libraryRootsWhere(roots?: string[]): Sql | undefined {
  if (roots === undefined) return undefined;
  if (roots.length === 0) return { text: "1=0", params: [] };
  const parts = roots.map((r) => pathUnderSql(r, { self: false }));
  return { text: `(${parts.map((p) => p.text).join(" OR ")})`, params: parts.flatMap((p) => p.params) };
}

/** Files carrying none of `tags` (or any tag beneath them). */
export function withoutTagsWhere(tags: string[]): Sql | undefined {
  if (tags.length === 0) return undefined;
  return {
    text: `NOT EXISTS (SELECT 1 FROM FileTag ft JOIN Tag t ON t.id = ft.tagId WHERE ft.fileId = f.id AND (${tags
      .map(() => "t.name = ? OR t.name LIKE ? ESCAPE '\\'")
      .join(" OR ")}))`,
    params: tags.flatMap((t) => [t, escapeLike(t) + "/%"]),
  };
}

/** The unfiltered main timeline (Settings → Timeline): files with a path inside
 *  a library and outside every excluded folder, carrying no excluded tag.
 *  Tag-rule aliases apply to excluded tags. undefined = unrestricted. */
export function mainTimelineWhere(): Sql | undefined {
  const roots = config.libraryRoots();
  const excluded = config.timelineExcludedPaths();
  const rules = getRules();
  const tags = [...new Set(config.get().timelineExclude.tags.map((t) => resolveAlias(rules, t)))];
  const parts: Sql[] = [];
  if (roots.length > 0 || excluded.length > 0) {
    // one FilePath must satisfy both, so a copy outside the excluded folders keeps the file
    const inside = roots.length > 0 ? orSql(roots.map((r) => fpUnderSql(r, { self: false }))) : { text: "1=1", params: [] };
    const outside = excluded.length > 0 ? orSql(excluded.map((p) => fpUnderSql(p))) : { text: "0=1", params: [] };
    parts.push({
      text: `EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id AND ${inside.text} AND NOT ${outside.text})`,
      params: [...inside.params, ...outside.params],
    });
  }
  const noTags = withoutTagsWhere(tags);
  if (noTags) parts.push(noTags);
  if (parts.length === 0) return undefined;
  return { text: parts.map((p) => `(${p.text})`).join(" AND "), params: parts.flatMap((p) => p.params) };
}

function orSql(parts: Sql[]): Sql {
  return { text: `(${parts.map((p) => p.text).join(" OR ")})`, params: parts.flatMap((p) => p.params) };
}

/** Is there any row (matching `where`) newer than (mtime,id)? Drives
 *  hasPreviousPage so scrolling up stops at the newest file. */
async function existsNewer(where: Sql | undefined, mtime: number, id: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM File f WHERE ${where?.text ?? "1=1"}
     AND (f.mtime, f.id) > (?, ?) LIMIT 1`,
    ...(where?.params ?? []),
    mtime,
    id,
  );
  return rows.length > 0;
}

/** Execute the shared list query (§9.4) against the DB. */
export async function executeList(input: {
  where?: Sql;
  sort: Sort;
  cursor?: string | null;
  limit?: number;
}): Promise<ListResult> {
  const limit = input.limit ?? PAGE_SIZE;
  const cursor = input.cursor ?? null;
  const backward = cursor?.startsWith("^") ?? false;
  const seek = cursor?.startsWith("!") ?? false;
  const q = buildListQuery(input);
  const rawRows = await db.$queryRawUnsafe<
    (FileSummary & { mtime?: number | bigint | Date })[]
  >(q.text, ...q.params);

  // backward pages are fetched ASC (nearest newer first) then flipped to DESC
  const hasMore = rawRows.length > limit;
  // Drop the lookahead BEFORE reversing; otherwise every backward page skips a file.
  const page = rawRows.slice(0, limit);
  if (backward) page.reverse();
  const toMs = (v: number | bigint | Date | undefined): number =>
    v === undefined ? 0 : typeof v === "object" ? v.getTime() : Number(v);
  const items: FileSummary[] = page.map((r) => ({
    id: r.id,
    mediaType: r.mediaType,
    width: r.width,
    height: r.height,
    duration: r.duration,
    mtime: toMs(r.mtime),
    favorite: Boolean(r.favorite),
  }));

  // nextCursor (older) only for forward pages; a backward page's "more" is newer
  let nextCursor: string | null = null;
  if (!backward && hasMore) {
    nextCursor = nextCursorFor(
      input.sort,
      items,
      cursor,
      page.map((r) => ({ mtime: new Date(toMs(r.mtime)) })),
    );
  }

  // prevCursor (newer) for the first page of a seek/backward chain
  let prevCursor: string | null = null;
  if ((backward || seek) && input.sort === "date" && page.length > 0) {
    const first = page[0]!;
    const firstMs = toMs(first.mtime);
    if (await existsNewer(input.where, firstMs, first.id)) {
      prevCursor = `^${firstMs}|${first.id}`;
    }
  }

  return { items, nextCursor, prevCursor };
}

/** Load a complete visible month; the client virtualizes its rows, not its data. */
export async function timelineMonth(where: Sql | undefined, month: z.infer<typeof timelineMonthSchema>): Promise<ListResult> {
  const start = new Date(0);
  start.setFullYear(month.year, month.month - 1, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  const rows = await db.$queryRawUnsafe<(Omit<FileSummary, "mtime" | "favorite"> & { mtime: number | bigint | Date; favorite: number | bigint })[]>(
    `SELECT ${SUMMARY_COLS} FROM File f
     WHERE (${where?.text ?? "1=1"}) AND f.mtime >= ? AND f.mtime < ?
     ORDER BY f.mtime DESC, f.id DESC`,
    ...(where?.params ?? []), start.getTime(), end.getTime(),
  );
  // ponytail: whole-month metadata, like Immich; page within a month if a single month exhausts memory.
  return {
    items: rows.map((r) => ({ ...r, mtime: r.mtime instanceof Date ? r.mtime.getTime() : Number(r.mtime), favorite: Boolean(r.favorite) })),
    nextCursor: null, prevCursor: null,
  };
}

/**
 * Month buckets for the timeline scrubber: one row per local calendar month
 * (newest first) with a file count and mtime range. `roots` limits the result
 * to files under those library roots (timeline-enabled libraries). mtime is
 * stored by Prisma as integer ms; `unixepoch` wants seconds.
 */
export async function timelineBuckets(where?: Sql, roots?: string[]): Promise<TimelineBucket[]> {
  const clauses = [where?.text ?? "1=1"];
  const params: unknown[] = [...(where?.params ?? [])];
  const libraries = libraryRootsWhere(roots);
  if (libraries) {
    clauses.push(libraries.text);
    params.push(...libraries.params);
  }
  const rows = await db.$queryRawUnsafe<
    { ym: string; count: number | bigint; mn: number | bigint; mx: number | bigint }[]
  >(
    `SELECT strftime('%Y-%m', f.mtime / 1000, 'unixepoch', 'localtime') AS ym,
            COUNT(*) AS count, MIN(f.mtime) AS mn, MAX(f.mtime) AS mx
     FROM File f WHERE ${clauses.join(" AND ")}
     GROUP BY ym ORDER BY mx DESC`,
    ...params,
  );
  return rows.map((r) => {
    const [year, month] = r.ym.split("-");
    return {
      year: Number(year),
      month: Number(month),
      count: Number(r.count),
      minMtime: Number(r.mn),
      maxMtime: Number(r.mx),
    };
  });
}

/** WHERE builder helpers used by files.list. */
export function pathPrefixWhere(prefix: string, recursive = false): Sql {
  // folders: by default direct children only — a file belongs to a folder if
  // its path is <prefix>/<name> with no further "/" in <name>. recursive=true
  // matches every descendant path (prefix + "/...")
  return pathUnderSql(prefix, { directOnly: !recursive, self: false });
}

/** WHERE for a browse source: a folder prefix or a tag (and its descendants). */
export function sourceWhere(input: {
  pathPrefix?: string;
  tag?: string;
  recursive?: boolean;
}): Sql | undefined {
  const recursive = input.recursive ?? true;
  if (input.pathPrefix !== undefined) {
    return pathPrefixWhere(input.pathPrefix, recursive);
  }
  if (input.tag !== undefined) {
    const tag = input.tag.replace(/[\\%_]/g, (c) => "\\" + c);
    if (recursive) {
      return {
        text: `EXISTS (SELECT 1 FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
               WHERE ft.fileId = f.id AND (t.name = ? OR t.name LIKE ? ESCAPE '\\'))`,
        params: [input.tag, tag + "/%"],
      };
    }
    return {
      text: `EXISTS (SELECT 1 FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
             WHERE ft.fileId = f.id AND t.name = ?)`,
      params: [input.tag],
    };
  }
  return undefined;
}

export function idsWhere(ids: string[]): Sql {
  if (ids.length === 0) return { text: "1=0", params: [] };
  return {
    text: `f.id IN (${ids.map(() => "?").join(",")})`,
    params: ids,
  };
}

/** Explicit ordered ids (queue/similar): preserve order, chunk the IN clause. */
export async function listByOrderedIds(ids: string[]): Promise<FileSummary[]> {
  if (ids.length === 0) return [];
  const CHUNK = 500;
  const byId = new Map<string, FileSummary>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db.file.findMany({
      where: { id: { in: ids.slice(i, i + CHUNK) } },
      select: { id: true, mediaType: true, width: true, height: true, duration: true, mtime: true, meta: { select: { favorite: true } } },
    });
    for (const { meta, ...r } of rows) byId.set(r.id, { ...r, mtime: r.mtime.getTime(), favorite: meta?.favorite ?? false });
  }
  return ids.map((id) => byId.get(id)).filter((r): r is FileSummary => r !== undefined);
}

/** Half-open path range covering every descendant of `dir` — index-friendly,
 *  unlike LIKE ("0" is the character after "/"). */
function descendantRange(dir: string): [string, string] {
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return [base + "/", base + "0"];
}

/** Distinct files anywhere under `dir` (recursive, like tag counts). */
export async function folderFileCount(dir: string): Promise<number> {
  const [lo, hi] = descendantRange(dir);
  const rows = await db.$queryRawUnsafe<{ c: bigint | number }[]>(
    `SELECT COUNT(DISTINCT fileId) AS c FROM FilePath WHERE path >= ? AND path < ?`,
    lo,
    hi,
  );
  return Number(rows[0]?.c ?? 0);
}

/** Recursive distinct-file counts for each immediate subfolder of `dir`, keyed
 *  by subfolder name — one range scan instead of a query per child. */
export async function subfolderFileCounts(dir: string): Promise<Map<string, number>> {
  const [lo, hi] = descendantRange(dir);
  const start = lo.length + 1; // 1-based offset of the segment after "<dir>/"
  const rows = await db.$queryRawUnsafe<{ seg: string; c: bigint | number }[]>(
    `SELECT substr(path, ?, instr(substr(path, ?), '/') - 1) AS seg, COUNT(DISTINCT fileId) AS c
     FROM FilePath WHERE path >= ? AND path < ? AND instr(substr(path, ?), '/') > 0
     GROUP BY seg`,
    start,
    start,
    lo,
    hi,
    start,
  );
  return new Map(rows.map((r) => [r.seg, Number(r.c)]));
}
