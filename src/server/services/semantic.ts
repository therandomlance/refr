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
  let candidates: Set<string> | null = null;
  if (tagChips.length > 0) {
    const where = tokensToWhere(tagChips);
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT f.id FROM File f WHERE ${where.text}`,
      ...where.params,
    );
    candidates = new Set(rows.map((r) => r.id));
  }

  const skip = cursor ? Number(cursor) : 0;
  const items: Hit[] = [];
  let fetched = skip;
  while (items.length < pageSize) {
    const batch = await fetchPage(q, 2000, fetched);
    if (batch.length === 0) break;
    fetched += batch.length;
    for (const hit of batch) {
      if (excludeId && hit.fileId === excludeId) continue;
      if (candidates && !candidates.has(hit.fileId)) continue;
      items.push(hit);
      if (items.length >= pageSize) break;
    }
  }

  const summaries = await listByOrderedIds(items.map((i) => i.fileId));
  const more = items.length >= pageSize;
  return { items: summaries, nextCursor: more ? String(fetched) : null };
}

/** §13.5: text chip → kNN; tag chips filter the kNN loop. Degrades to tag-only when ML is down. */
export async function semanticSearch(
  textChip: Token,
  tagChips: Token[],
  cursor: string | null | undefined,
  pageSize: number,
  fetchPage: FetchPage = ml.knn,
) {
  const status = await ml.status();
  if (status.state !== "ready") {
    const where = tokensToWhere(tagChips);
    return executeList({ where, sort: "date", cursor, limit: pageSize });
  }

  const [q] = await ml.embedText([textChip.tag]);
  if (!q) return { items: [], nextCursor: null };
  return vectorSearch(q, tagChips, cursor, pageSize, null, fetchPage);
}

/** §13.6: find-similar chip → file vector → kNN; tag chips filter. Degrades to tag-only. */
export async function similarSearch(
  fileId: string,
  tagChips: Token[],
  cursor: string | null | undefined,
  pageSize: number,
) {
  const status = await ml.status();
  if (status.state !== "ready") {
    const where = tokensToWhere(tagChips);
    return executeList({ where, sort: "date", cursor, limit: pageSize });
  }

  const q = await ml.fileVector(fileId);
  if (!q) return { items: [], nextCursor: null };
  return vectorSearch(q, tagChips, cursor, pageSize, fileId);
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
  const status = await ml.status();
  if (status.state !== "ready") {
    const where = tokensToWhere(tagChips);
    return executeList({ where, sort: "date", cursor, limit: pageSize });
  }

  const q = await ml.tagVectorByName(tagName);
  if (!q) return { items: [], nextCursor: null };
  const excluded = await ml.getExclusions(tagName);
  const excludeIds = excluded.size ? [...excluded] : undefined;
  return vectorSearch(q, tagChips, cursor, pageSize, null, (vec, k, skip) =>
    ml.knn(vec, k, skip, tagName, excludeIds));
}
