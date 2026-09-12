import "server-only";
import { db } from "refr/server/db";
import type { TimelineBucket } from "refr/lib/timeline";
import {
  buildListQuery,
  nextCursorFor,
  PAGE_SIZE,
  type FileSummary,
  type ListResult,
  type Sort,
} from "./search";

type Sql = { text: string; params: unknown[] };

/** Is there any row (matching `where`) newer than (mtime,id)? Drives
 *  hasPreviousPage so scrolling up stops at the newest file. */
async function existsNewer(where: Sql | undefined, mtime: number, id: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM File f WHERE ${where?.text ?? "1=1"}
     AND (f.mtime > ? OR (f.mtime = ? AND f.id > ?)) LIMIT 1`,
    ...(where?.params ?? []),
    mtime,
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
  const ordered = backward ? [...rawRows].reverse() : rawRows;
  const hasMore = ordered.length > limit;
  const page = ordered.slice(0, limit);
  const toMs = (v: number | bigint | Date | undefined): number =>
    v === undefined ? 0 : typeof v === "object" ? v.getTime() : Number(v);
  const items: FileSummary[] = page.map((r) => ({
    id: r.id,
    mediaType: r.mediaType,
    width: r.width,
    height: r.height,
    duration: r.duration,
    mtime: toMs(r.mtime),
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

/**
 * Month buckets for the timeline scrubber: one row per local calendar month
 * (newest first) with a file count and mtime range. `roots` limits the result
 * to files under those library roots (timeline-enabled libraries). mtime is
 * stored by Prisma as integer ms; `unixepoch` wants seconds.
 */
export async function timelineBuckets(where?: Sql, roots?: string[]): Promise<TimelineBucket[]> {
  const clauses = [where?.text ?? "1=1"];
  const params: unknown[] = [...(where?.params ?? [])];
  if (roots !== undefined) {
    if (roots.length === 0) {
      clauses.push("1=0");
    } else {
      const ors = roots.map(() => "fp.path LIKE ? ESCAPE '\\'").join(" OR ");
      clauses.push(`EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id AND (${ors}))`);
      for (const r of roots) params.push(r.replace(/[\\%_]/g, (c) => "\\" + c) + "/%");
    }
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
  const esc = prefix.replace(/[\\%_]/g, (c) => "\\" + c);
  if (recursive) {
    return {
      text: `EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id
             AND fp.path LIKE ? ESCAPE '\\')`,
      params: [esc + "/%"],
    };
  }
  return {
    text: `EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id
           AND fp.path LIKE ? ESCAPE '\\' AND instr(substr(fp.path, ?), '/') = 0)`,
    params: [esc + "/%", prefix.length + 2],
  };
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
      select: { id: true, mediaType: true, width: true, height: true, duration: true, mtime: true },
    });
    for (const r of rows) byId.set(r.id, { ...r, mtime: r.mtime.getTime() });
  }
  return ids.map((id) => byId.get(id)).filter((r): r is FileSummary => r !== undefined);
}
