import "server-only";
import { db } from "refr/server/db";

/** Per-file user data in FileMeta (1:1 with File, rows created lazily). */

const CHUNK = 400;

/** Update a file's source URL and/or note. Empty strings clear them. */
export async function setMeta(fileId: string, patch: { source?: string; note?: string }) {
  const data: { source?: string | null; note?: string | null } = {};
  if (patch.source !== undefined) data.source = patch.source.trim() ? patch.source.trim() : null;
  if (patch.note !== undefined) data.note = patch.note.trim() ? patch.note : null;
  await db.fileMeta.upsert({ where: { fileId }, create: { fileId, ...data }, update: data });
}

/** Set or clear the favorite flag on files. `favorite` omitted = toggle: clear
 *  when every file is already a favorite, otherwise set. Unknown ids are ignored. */
export async function setFavorite(fileIds: string[], favorite?: boolean): Promise<{ favorite: boolean; updated: number }> {
  const ids = [...new Set(fileIds)];
  if (favorite === undefined) {
    let favs = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      favs += await db.fileMeta.count({ where: { fileId: { in: ids.slice(i, i + CHUNK) }, favorite: true } });
    }
    favorite = favs < ids.length;
  }
  let updated = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    updated += await db.$executeRawUnsafe(
      `INSERT INTO FileMeta (fileId, favorite)
       SELECT id, ? FROM File WHERE id IN (${batch.map(() => "?").join(",")})
       ON CONFLICT (fileId) DO UPDATE SET favorite = excluded.favorite`,
      favorite, ...batch,
    );
  }
  return { favorite, updated };
}
