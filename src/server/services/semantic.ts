import "server-only";
import { db } from "refr/server/db";
import { tokensToWhere, type Token } from "./search";
import { executeList, listByOrderedIds } from "./fileQuery";
import * as ml from "./ml";

type Hit = { fileId: string; score: number };
type FetchPage = (q: Float32Array, k: number, skip: number) => Promise<Hit[]>;

/**
 * Shared kNN loop (§13.5): paginate the sidecar kNN by `skip`, filter by the
 * tag-chip candidate set, optionally exclude one id (the similar seed itself).
 * Caller guarantees ML is ready (or degrades before calling).
 */
export async function vectorSearch(
  q: Float32Array,
  tagChips: Token[],
  cursor: string | null | undefined,
  pageSize: number,
  excludeId: string | null,
  fetchPage: FetchPage = ml.knn,
) {
  const where = tokensToWhere(tagChips);

  const skip = cursor ? Number(cursor) : 0;
  const items: Hit[] = [];
  let consumed = skip;
  while (items.length < pageSize) {
    const batch = await fetchPage(q, 2000, consumed);
    if (batch.length === 0) break;
    const ids = batch.map((hit) => hit.fileId);
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT f.id FROM File f JOIN json_each(?) j ON j.value = f.id WHERE ${where.text}`,
      JSON.stringify(ids), ...where.params,
    );
    const allowed = new Set(rows.map((r) => r.id));
    let examined = 0;
    for (const hit of batch) {
      examined++;
      if (excludeId && hit.fileId === excludeId) continue;
      if (!allowed.has(hit.fileId)) continue;
      items.push(hit);
      if (items.length >= pageSize) break;
    }
    consumed += examined;
    if (batch.length < 2000) break;
  }

  const summaries = await listByOrderedIds(items.map((i) => i.fileId));
  const more = items.length >= pageSize;
  return { items: summaries, nextCursor: more ? String(consumed) : null, prevCursor: null };
}

const fallbackNotice = "Semantic search is unavailable; showing tag-only results.";
async function fallback(tagChips: Token[], cursor: string | null | undefined, pageSize: number) {
  if (cursor && !cursor.startsWith("tag:")) {
    // A ranking change cannot be appended to the old list; the grid restarts it.
    return { items: [], nextCursor: null, prevCursor: null, notice: fallbackNotice, restart: true };
  }
  const page = await executeList({
    where: tokensToWhere(tagChips), sort: "date",
    cursor: cursor?.startsWith("tag:") ? cursor.slice(4) : null, limit: pageSize,
  });
  return { ...page, nextCursor: page.nextCursor ? `tag:${page.nextCursor}` : null, notice: fallbackNotice };
}

async function withFallback(
  tagChips: Token[], cursor: string | null | undefined, pageSize: number,
  run: () => ReturnType<typeof vectorSearch>,
) {
  // Keep a fallback list in date order through pagination, even if ML recovers.
  if (cursor?.startsWith("tag:") || (await ml.status()).state !== "ready") return fallback(tagChips, cursor, pageSize);
  try {
    return await run();
  } catch (error) {
    if (error instanceof ml.SidecarError) return fallback(tagChips, cursor, pageSize);
    throw error;
  }
}

/** §13.5: text chip → kNN; tag chips filter the kNN loop. Degrades to tag-only when ML is down. */
export async function semanticSearch(
  textChip: Token,
  tagChips: Token[],
  cursor: string | null | undefined,
  pageSize: number,
  fetchPage: FetchPage = ml.knn,
) {
  return withFallback(tagChips, cursor, pageSize, async () => {
    const [q] = await ml.embedText([textChip.tag]);
    return q ? vectorSearch(q, tagChips, cursor, pageSize, null, fetchPage) : { items: [], nextCursor: null, prevCursor: null };
  });
}

/** §13.6: find-similar chip → file vector → kNN; tag chips filter. Degrades to tag-only. */
export async function similarSearch(
  fileId: string,
  tagChips: Token[],
  cursor: string | null | undefined,
  pageSize: number,
) {
  return withFallback(tagChips, cursor, pageSize, async () => {
    const q = await ml.fileVector(fileId);
    return q ? vectorSearch(q, tagChips, cursor, pageSize, fileId) : { items: [], nextCursor: null, prevCursor: null };
  });
}

/** suggest:<tag> chip → tag vector → kNN (excluding files already tagged with the
 *  tag or descendants + manual denials); tag chips filter the kNN loop. Degrades
 *  to tag-only when ML is down. */
export async function suggestSearch(
  tagName: string,
  tagChips: Token[],
  cursor: string | null | undefined,
  pageSize: number,
) {
  return withFallback(tagChips, cursor, pageSize, async () => {
    const q = await ml.tagVectorByName(tagName);
    if (!q) return { items: [], nextCursor: null, prevCursor: null };
    const excluded = await ml.getExclusions(tagName);
    return vectorSearch(q, tagChips, cursor, pageSize, null, (vec, k, skip) =>
      ml.knn(vec, k, skip, tagName, excluded.size ? [...excluded] : undefined));
  });
}
