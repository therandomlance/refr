import "server-only";
import { db } from "refr/server/db";
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

/** WHERE builder helpers used by files.list. */
export function pathPrefixWhere(prefix: string): Sql {
  // folders: direct children only — a file belongs to a folder if its path is
  // <prefix>/<name> with no further "/" in <name> (unlike tags, no descendants)
  return {
    text: `EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id
           AND fp.path LIKE ? ESCAPE '\\' AND instr(substr(fp.path, ?), '/') = 0)`,
    params: [prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "/%", prefix.length + 2],
  };
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
  const rows = await db.file.findMany({
    where: { id: { in: ids } },
    select: { id: true, mediaType: true, width: true, height: true, duration: true, mtime: true },
  });
  const byId = new Map(rows.map((r) => [r.id, { ...r, mtime: r.mtime.getTime() }]));
  return ids.map((id) => byId.get(id)).filter((r): r is FileSummary => r !== undefined);
}
