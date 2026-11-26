import "server-only";
import fsp from "node:fs/promises";
import { db } from "refr/server/db";
import { setTags } from "./tags";
import { thumbPath } from "./thumbs";

/**
 * Near-duplicate finder. Each image gets a 64-bit difference hash (dHash) of
 * its thumbnail; pairs within a small Hamming distance are candidates. Pairs
 * are found with LSH banding: the hash is split into 4 bands of 16 bits, and
 * by pigeonhole any two hashes ≤ 3 bits apart agree exactly on at least one
 * band, so only same-bucket hashes are compared.
 *
 * Resolving a pair never touches library files: the copy's tags (and favorite,
 * source, note) are merged onto the keeper and the copy is hidden via
 * FileMeta.duplicateOf (see VISIBLE_SQL in search.ts; `is:duplicate` lists them).
 */

export const MAX_DISTANCE = 3;
// near-flat images (popcount ≈ 0 or 64) all look alike to dHash: not duplicates
const MIN_BITS = 4;
// a bucket this large is texture/noise collapsing together, not real copies
const MAX_BUCKET = 400;

// ---------------------------------------------------------------- hashing

/** dHash of an image file: 9×8 grayscale, each bit = left pixel brighter than its right neighbour. */
export async function dhashOf(file: string): Promise<bigint> {
  const sharp = (await import("sharp")).default;
  const px = await sharp(file).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let h = 0n;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      h = (h << 1n) | (px[r * 9 + c]! > px[r * 9 + c + 1]! ? 1n : 0n);
    }
  }
  return BigInt.asIntN(64, h); // stored as a signed SQLite INTEGER
}

type HashWorker = { running: Promise<void> | null; done: number; total: number };
const globalForDup = globalThis as typeof globalThis & { refrDhash?: HashWorker };
const hashWorker = globalForDup.refrDhash ??= { running: null, done: 0, total: 0 };

export function hashStatus() {
  return { running: hashWorker.running !== null, done: hashWorker.done, total: hashWorker.total };
}

/** Single-flight background pass: hash every image whose thumbnail exists but
 *  has no dHash yet. Keyset-paged; files without a thumbnail are skipped and
 *  retried on a later pass (after thumbnail generation drains). */
export function catchUpDhash(): Promise<void> {
  if (hashWorker.running) return hashWorker.running;
  hashWorker.running = (async () => {
    const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM File f LEFT JOIN FileMeta m ON m.fileId = f.id
       WHERE f.mediaType = 'image' AND m.dhash IS NULL`,
    ) as [{ n: bigint }];
    hashWorker.total = Number(n);
    hashWorker.done = 0;
    let after = "";
    for (;;) {
      const rows = await db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT f.id FROM File f LEFT JOIN FileMeta m ON m.fileId = f.id
         WHERE f.mediaType = 'image' AND m.dhash IS NULL AND f.id > ?
         ORDER BY f.id LIMIT 200`,
        after,
      );
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.id;
      for (const { id } of rows) {
        hashWorker.done++;
        const thumb = thumbPath(id);
        if (!(await fsp.access(thumb).then(() => true, () => false))) continue;
        try {
          await storeHash(id, await dhashOf(thumb));
        } catch {
          // unreadable thumbnail — leave unhashed
        }
      }
    }
  })().finally(() => {
    hashWorker.running = null;
  });
  return hashWorker.running;
}

export async function storeHash(fileId: string, hash: bigint) {
  await db.$executeRawUnsafe(
    `INSERT INTO FileMeta (fileId, dhash) VALUES (?, ?) ON CONFLICT (fileId) DO UPDATE SET dhash = excluded.dhash`,
    fileId, hash,
  );
}

// ---------------------------------------------------------------- pairs

export type DuplicatePair = { a: string; b: string; distance: number };

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Every pair of hashes within `maxDistance` bits (≤ 3 guaranteed by the
 * 4×16-bit banding), skipping `dismissed` keys ("a|b", a < b). Pure; exported
 * for tests. Sorted by distance, then ids.
 */
export function findPairs(
  entries: { id: string; hash: bigint }[],
  dismissed = new Set<string>(),
  maxDistance = MAX_DISTANCE,
): DuplicatePair[] {
  const n = entries.length;
  const hi = new Uint32Array(n);
  const lo = new Uint32Array(n);
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = BigInt.asUintN(64, entries[i]!.hash);
    hi[i] = Number(u >> 32n);
    lo[i] = Number(u & 0xffffffffn);
    const bits = popcount32(hi[i]!) + popcount32(lo[i]!);
    if (bits >= MIN_BITS && bits <= 64 - MIN_BITS) keep.push(i);
  }
  const seen = new Set<string>();
  const out: DuplicatePair[] = [];
  const bands = [(i: number) => lo[i]! & 0xffff, (i: number) => lo[i]! >>> 16, (i: number) => hi[i]! & 0xffff, (i: number) => hi[i]! >>> 16];
  for (const band of bands) {
    const buckets = new Map<number, number[]>();
    for (const i of keep) {
      const k = band(i);
      const list = buckets.get(k);
      if (list) list.push(i);
      else buckets.set(k, [i]);
    }
    for (const list of buckets.values()) {
      if (list.length < 2 || list.length > MAX_BUCKET) continue;
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const i = list[x]!;
          const j = list[y]!;
          const d = popcount32(hi[i]! ^ hi[j]!) + popcount32(lo[i]! ^ lo[j]!);
          if (d > maxDistance) continue;
          const [a, b] = [entries[i]!.id, entries[j]!.id].sort() as [string, string];
          const key = `${a}|${b}`;
          if (seen.has(key) || dismissed.has(key)) continue;
          seen.add(key);
          out.push({ a, b, distance: d });
        }
      }
    }
  }
  return out.sort((p, q) => p.distance - q.distance || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
}

let pairCache: { stamp: string; pairs: DuplicatePair[] } | null = null;

async function cacheStamp(): Promise<string> {
  const [s] = await db.$queryRawUnsafe<{ hashed: bigint; hidden: bigint; dismissed: bigint; files: bigint }[]>(
    `SELECT (SELECT COUNT(dhash) FROM FileMeta) AS hashed, (SELECT COUNT(duplicateOf) FROM FileMeta) AS hidden,
            (SELECT COUNT(*) FROM DuplicateDismissal) AS dismissed, (SELECT COUNT(*) FROM File) AS files`,
  );
  return `${s!.hashed}|${s!.hidden}|${s!.dismissed}|${s!.files}`;
}

/** Apply a review action to the cached pair list in place instead of letting
 *  the stamp change force a full reload + rescan on the next list call. Only
 *  patches when the cache was current before the write (`before`); otherwise
 *  the next call rebuilds as usual. */
async function patchCache(before: string, drop: (p: DuplicatePair) => boolean) {
  const cache = pairCache;
  if (cache?.stamp !== before) return;
  const pairs = cache.pairs.filter((p) => !drop(p));
  const stamp = await cacheStamp();
  if (pairCache === cache) pairCache = { stamp, pairs };
}

/** All current candidate pairs among visible files. Cached until hashes,
 *  hidden copies or dismissals change. */
async function allPairs(): Promise<DuplicatePair[]> {
  const stamp = await cacheStamp();
  if (pairCache?.stamp === stamp) return pairCache.pairs;
  const rows = await db.$queryRawUnsafe<{ id: string; dhash: bigint }[]>(
    `SELECT fileId AS id, dhash FROM FileMeta WHERE dhash IS NOT NULL AND duplicateOf IS NULL`,
  );
  const dismissed = await db.duplicateDismissal.findMany();
  const pairs = findPairs(
    rows.map((r) => ({ id: r.id, hash: BigInt(r.dhash) })),
    new Set(dismissed.map((d) => `${d.a}|${d.b}`)),
  );
  pairCache = { stamp, pairs };
  return pairs;
}

export type PairFile = { id: string; width: number | null; height: number | null; size: number; path: string | null; mediaType: string; tags: number };

/** A page of pairs (optionally only those involving `fileId`), with the file
 *  details the review UI compares. */
export async function listPairs(input: { fileId?: string; offset: number; limit: number }) {
  let pairs = await allPairs();
  if (input.fileId) pairs = pairs.filter((p) => p.a === input.fileId || p.b === input.fileId);
  const page = pairs.slice(input.offset, input.offset + input.limit);
  const ids = [...new Set(page.flatMap((p) => [p.a, p.b]))];
  const files = await db.file.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, width: true, height: true, size: true, mediaType: true,
      paths: { select: { path: true }, orderBy: { path: "asc" }, take: 1 },
      _count: { select: { tags: true } },
    },
  });
  const byId = new Map<string, PairFile>(files.map((f) => [f.id, {
    id: f.id, width: f.width, height: f.height, size: Number(f.size), mediaType: f.mediaType,
    path: f.paths[0]?.path ?? null, tags: f._count.tags,
  }]));
  return {
    total: pairs.length,
    pairs: page.flatMap((p) => {
      const a = byId.get(p.a);
      const b = byId.get(p.b);
      return a && b ? [{ a, b, distance: p.distance }] : [];
    }),
    hashing: hashStatus(),
  };
}

const filled = (s: string | null | undefined) => (s?.trim() ? s : null);

// review actions run one at a time so each cache patch sees only its own write
let reviewChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = reviewChain.then(fn, fn);
  reviewChain = run.catch(() => undefined);
  return run;
}

/** Merge `copy` into `keeper` and hide `copy`. Library files are untouched. */
export function resolvePair(keeper: string, copy: string) {
  return serial(() => resolveNow(keeper, copy));
}

async function resolveNow(keeper: string, copy: string) {
  if (keeper === copy) throw new Error("keeper and copy are the same file");
  const before = await cacheStamp();
  // a hidden keeper becomes visible again below and may gain pairs: rebuild then
  const keeperHidden = (await db.fileMeta.findUnique({ where: { fileId: keeper }, select: { duplicateOf: true } }))?.duplicateOf != null;
  const links = await db.fileTag.findMany({ where: { fileId: copy }, include: { tag: true } });
  if (links.length) await setTags([keeper], links.map((l) => l.tag.name), []);
  await db.$transaction(async (tx) => {
    const [k, c] = await Promise.all([
      tx.fileMeta.findUnique({ where: { fileId: keeper } }),
      tx.fileMeta.findUnique({ where: { fileId: copy } }),
    ]);
    await tx.fileMeta.upsert({
      where: { fileId: keeper },
      create: { fileId: keeper, favorite: c?.favorite ?? false, source: c?.source ?? null, note: c?.note ?? null },
      update: {
        favorite: (k?.favorite ?? false) || (c?.favorite ?? false),
        source: filled(k?.source) ?? filled(c?.source),
        note: filled(k?.note) ?? filled(c?.note),
        duplicateOf: null,
      },
    });
    await tx.fileMeta.upsert({
      where: { fileId: copy },
      create: { fileId: copy, duplicateOf: keeper },
      update: { duplicateOf: keeper },
    });
    // copies previously hidden under `copy` now point at the surviving keeper
    await tx.fileMeta.updateMany({ where: { duplicateOf: copy }, data: { duplicateOf: keeper } });
  });
  if (!keeperHidden) await patchCache(before, (p) => p.a === copy || p.b === copy);
}

export function dismissPair(x: string, y: string) {
  const [a, b] = [x, y].sort() as [string, string];
  return serial(async () => {
    const before = await cacheStamp();
    await db.duplicateDismissal.upsert({ where: { a_b: { a, b } }, create: { a, b }, update: {} });
    await patchCache(before, (p) => p.a === a && p.b === b);
  });
}

export async function unhide(fileId: string) {
  await db.fileMeta.updateMany({ where: { fileId }, data: { duplicateOf: null } });
}
