import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db } from "refr/server/db";
import * as config from "./config";
import { paths } from "./dataDir";
import { setFavorite } from "./fileMeta";
import { setTags } from "./tags";

/**
 * Backups of the data that lives only in SQLite (tags, favorites, sources,
 * notes): a portable JSON-lines export/import, and `VACUUM INTO` snapshots of
 * refr.db kept in data/backups/.
 */

// ---------------------------------------------------------------- export

export type ExportLine = {
  id: string;
  paths: string[];
  tags: string[];
  favorite?: boolean;
  source?: string;
  note?: string;
};

/** One JSON object per line, keyset-paged so the whole catalog is never in memory.
 *  Files with no tags and no metadata are skipped. */
export async function* exportLines(): AsyncGenerator<string, void, undefined> {
  let after = "";
  for (;;) {
    const files = await db.file.findMany({
      where: { id: { gt: after } },
      orderBy: { id: "asc" },
      take: 500,
      select: {
        id: true,
        paths: { select: { path: true }, orderBy: { path: "asc" } },
        tags: { select: { tag: { select: { name: true } } } },
        meta: { select: { favorite: true, source: true, note: true } },
      },
    });
    if (files.length === 0) return;
    after = files[files.length - 1]!.id;
    for (const f of files) {
      const line: ExportLine = { id: f.id, paths: f.paths.map((p) => p.path), tags: f.tags.map((t) => t.tag.name).sort() };
      if (f.meta?.favorite) line.favorite = true;
      if (f.meta?.source) line.source = f.meta.source;
      if (f.meta?.note) line.note = f.meta.note;
      if (line.tags.length || line.favorite || line.source || line.note) yield JSON.stringify(line) + "\n";
    }
  }
}

// ---------------------------------------------------------------- import

export type ImportReport = { lines: number; matched: number; unmatched: number; invalid: number; changedFiles: number };

const BATCH = 500;

/**
 * Merge an export back in. Files are matched by content hash, else by any of
 * their recorded paths. Only adds: tags are added (through setTags, so tag
 * rules apply), favorites set, and source/note filled where empty.
 */
export async function importLines(lines: AsyncIterable<string>): Promise<ImportReport> {
  const report: ImportReport = { lines: 0, matched: 0, unmatched: 0, invalid: 0, changedFiles: 0 };
  const changed = new Set<string>();
  let batch: ExportLine[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const items = batch;
    batch = [];
    const known = new Set(
      (await db.file.findMany({ where: { id: { in: items.map((l) => l.id) } }, select: { id: true } })).map((f) => f.id),
    );
    const byPath = new Map(
      (await db.filePath.findMany({
        where: { path: { in: items.filter((l) => !known.has(l.id)).flatMap((l) => l.paths) } },
        select: { path: true, fileId: true },
      })).map((p) => [p.path, p.fileId]),
    );
    const byTag = new Map<string, string[]>();
    const favorites: string[] = [];
    for (const line of items) {
      const fileId = known.has(line.id) ? line.id : line.paths.map((p) => byPath.get(p)).find(Boolean);
      if (!fileId) {
        report.unmatched++;
        continue;
      }
      report.matched++;
      for (const tag of line.tags) byTag.set(tag, [...(byTag.get(tag) ?? []), fileId]);
      if (line.favorite) favorites.push(fileId);
      if (line.source || line.note) {
        const cur = await db.fileMeta.findUnique({ where: { fileId }, select: { source: true, note: true } });
        const data = {
          ...(line.source && !cur?.source ? { source: line.source } : {}),
          ...(line.note && !cur?.note ? { note: line.note } : {}),
        };
        if (Object.keys(data).length) {
          await db.fileMeta.upsert({ where: { fileId }, create: { fileId, ...data }, update: data });
          changed.add(fileId);
        }
      }
    }
    for (const [tag, ids] of byTag) {
      const { changes } = await setTags(ids, [tag], []);
      for (const c of changes) changed.add(c.fileId);
    }
    if (favorites.length) {
      const before = new Set(
        (await db.fileMeta.findMany({ where: { fileId: { in: favorites }, favorite: true }, select: { fileId: true } })).map((m) => m.fileId),
      );
      await setFavorite(favorites, true);
      for (const id of favorites) if (!before.has(id)) changed.add(id);
    }
  };

  for await (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    report.lines++;
    try {
      const v = JSON.parse(text) as Partial<ExportLine>;
      if (typeof v.id !== "string" || !Array.isArray(v.tags)) throw new Error("not an export line");
      batch.push({
        id: v.id,
        paths: Array.isArray(v.paths) ? v.paths.filter((p): p is string => typeof p === "string") : [],
        tags: v.tags.filter((t): t is string => typeof t === "string"),
        favorite: v.favorite === true,
        source: typeof v.source === "string" ? v.source : undefined,
        note: typeof v.note === "string" ? v.note : undefined,
      });
    } catch {
      report.invalid++;
    }
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  report.changedFiles = changed.size;
  return report;
}

/** Split a byte stream into text lines. */
export async function* streamLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop()!;
    yield* parts;
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

// ---------------------------------------------------------------- snapshots

const SNAPSHOT_RE = /^refr-\d{8}-\d{6}\.db$/;

export function listSnapshots(): { name: string; size: number; createdAt: string }[] {
  if (!fs.existsSync(paths.backups)) return [];
  return fs
    .readdirSync(paths.backups)
    .filter((n) => SNAPSHOT_RE.test(n))
    .sort()
    .reverse()
    .map((name) => {
      const st = fs.statSync(path.join(paths.backups, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    });
}

/** Consistent copy of refr.db (safe while the app runs, WAL included), then
 *  prune to the newest `backup.keep`. */
export async function snapshotDb(): Promise<string> {
  fs.mkdirSync(paths.backups, { recursive: true });
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `refr-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`;
  const target = path.join(paths.backups, name);
  const tmp = target + ".tmp";
  fs.rmSync(tmp, { force: true });
  await db.$executeRawUnsafe(`VACUUM INTO ?`, tmp);
  fs.renameSync(tmp, target);
  const keep = config.get().backup.keep;
  for (const old of listSnapshots().slice(keep)) fs.rmSync(path.join(paths.backups, old.name), { force: true });
  return name;
}
