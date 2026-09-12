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

/** Execute the shared list query (§9.4) against the DB. */
export async function executeList(input: {
  where?: Sql;
  sort: Sort;
  cursor?: string | null;
  limit?: number;
}): Promise<ListResult> {
  const limit = input.limit ?? PAGE_SIZE;
  const q = buildListQuery(input);
  const rows = await db.$queryRawUnsafe<
    (FileSummary & { mtime?: number | bigint | Date })[]
  >(q.text, ...q.params);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
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

  let nextCursor: string | null = null;
  if (hasMore) {
    nextCursor = nextCursorFor(
      input.sort,
      items,
      input.cursor,
      page.map((r) => ({ mtime: new Date(toMs(r.mtime)) })),
    );
  }
  return { items, nextCursor };
}

/**
 * Month buckets for the timeline scrubber: one row per local calendar month
 * (newest first) with a file count and the newest mtime (the seek anchor).
 * mtime is stored by Prisma as integer ms; `unixepoch` wants seconds.
 */
export async function timelineBuckets(where?: Sql): Promise<TimelineBucket[]> {
  const text = where?.text ?? "1=1";
  const rows = await db.$queryRawUnsafe<
    { ym: string; count: number | bigint; mx: number | bigint }[]
  >(
    `SELECT strftime('%Y-%m', f.mtime / 1000, 'unixepoch', 'localtime') AS ym,
            COUNT(*) AS count, MAX(f.mtime) AS mx
     FROM File f WHERE ${text}
     GROUP BY ym ORDER BY mx DESC`,
    ...(where?.params ?? []),
  );
  return rows.map((r) => {
    const [year, month] = r.ym.split("-");
    return {
      year: Number(year),
      month: Number(month),
      count: Number(r.count),
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
