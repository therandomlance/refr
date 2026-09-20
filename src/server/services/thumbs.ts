import "server-only";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { paths } from "./dataDir";
import { db } from "refr/server/db";

const execFileP = promisify(execFile);

export type ThumbJob = { fileId: string; mediaType: string; path: string };

const queue: ThumbJob[] = [];
const queued = new Set<string>();
let workers = 0;
const CONCURRENCY = 2;
let total = 0;
let processed = 0;
let onDrain: (() => void) | null = null;
export function setOnThumbDrain(cb: (() => void) | null) {
  onDrain = cb;
}

/** Queue progress since boot (per module instance, like scan progress). */
export function thumbStatus() {
  return { running: queue.length > 0 || workers > 0, pending: queue.length + workers, processed, total };
}

/** 2-hex shard: keeps any one directory to a manageable size. */
function shardDir(fileId: string): string {
  return path.join(paths.thumbnails, fileId.slice(0, 2));
}

export function thumbPath(fileId: string): string {
  return path.join(shardDir(fileId), `${fileId}.webp`);
}

export function hasThumb(fileId: string): boolean {
  return fs.existsSync(thumbPath(fileId));
}

export function deleteThumb(fileId: string) {
  fs.rmSync(thumbPath(fileId), { force: true });
}

/** One-time boot migration: move flat `thumbnails/<id>.webp` into 2-hex
 *  subdirs. Idempotent (skips anything already sharded). */
export async function migrateThumbLayout(): Promise<number> {
  const names = await fsp.readdir(paths.thumbnails).catch(() => [] as string[]);
  let moved = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.webp$/.test(name)) continue;
    const fileId = name.slice(0, -5);
    await fsp.mkdir(shardDir(fileId), { recursive: true });
    await fsp.rename(path.join(paths.thumbnails, name), thumbPath(fileId)).catch(() => undefined);
    moved++;
  }
  return moved;
}

/** In-process FIFO queue, concurrency 2, drained after scans and at boot. */
export function enqueueThumbs(jobs: ThumbJob[]) {
  let added = 0;
  for (const j of jobs) {
    if (queued.has(j.fileId)) continue;
    queued.add(j.fileId);
    queue.push(j);
    added++;
  }
  total += added;
  pump();
}

function pump() {
  while (workers < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    queued.delete(job.fileId);
    workers++;
    void makeThumb(job)
      .catch(() => undefined)
      .finally(() => {
        workers--;
        processed++;
        pump();
        if (queue.length === 0 && workers === 0) onDrain?.();
      });
  }
}

/** Every cached thumbnail on disk (sharded, plus any legacy flat leftovers). */
async function listThumbs(): Promise<{ id: string; file: string }[]> {
  const out: { id: string; file: string }[] = [];
  const entries = await fsp.readdir(paths.thumbnails, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile() && /^[0-9a-f]{64}\.webp$/.test(e.name)) {
      out.push({ id: e.name.slice(0, -5), file: path.join(paths.thumbnails, e.name) });
    } else if (e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name)) {
      const dir = path.join(paths.thumbnails, e.name);
      for (const n of await fsp.readdir(dir).catch(() => [] as string[])) {
        if (/^[0-9a-f]{64}\.webp$/.test(n)) out.push({ id: n.slice(0, -5), file: path.join(dir, n) });
      }
    }
  }
  return out;
}

/** Delete cached thumbnails with no matching File row. Returns count removed. */
export async function purgeOrphanThumbs(): Promise<number> {
  const thumbs = await listThumbs();
  if (thumbs.length === 0) return 0;
  const keep = new Set((await db.file.findMany({ select: { id: true } })).map((f) => f.id));
  let n = 0;
  for (const t of thumbs) {
    if (!keep.has(t.id)) {
      await fsp.rm(t.file, { force: true });
      n++;
    }
  }
  return n;
}

async function makeThumb(job: ThumbJob) {
  if (hasThumb(job.fileId)) return;
  const sharp = (await import("sharp")).default;
  let input = job.path;
  let tmp: string | null = null;
  if (job.mediaType === "video") {
    tmp = path.join(os.tmpdir(), `refr-thumb-${job.fileId}.png`);
    if (!(await extractFrame(job.path, tmp))) return;
    input = tmp;
  }
  try {
    await fsp.mkdir(shardDir(job.fileId), { recursive: true });
    await sharp(input)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(thumbPath(job.fileId) + ".tmp");
    await fsp.rename(thumbPath(job.fileId) + ".tmp", thumbPath(job.fileId));
  } catch {
    await fsp.rm(thumbPath(job.fileId) + ".tmp", { force: true }).catch(() => undefined);
  } finally {
    if (tmp) await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function extractFrame(videoPath: string, out: string): Promise<boolean> {
  // seek to 10% of duration, fall back to 0
  let seek = "0";
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", videoPath,
    ]);
    const d = parseFloat((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration ?? "0");
    if (d > 0) seek = String(d * 0.1);
  } catch {
    /* ffprobe missing — try seek 0 */
  }
  for (const ss of [seek, "0"]) {
    try {
      await execFileP("ffmpeg", ["-y", "-ss", ss, "-i", videoPath, "-frames:v", "1", out]);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return true;
    } catch {
      // try next seek
    }
  }
  return false;
}
