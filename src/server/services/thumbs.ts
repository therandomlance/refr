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

export function thumbPath(fileId: string): string {
  return path.join(paths.thumbnails, `${fileId}.webp`);
}

export function hasThumb(fileId: string): boolean {
  return fs.existsSync(thumbPath(fileId));
}

export function deleteThumb(fileId: string) {
  fs.rmSync(thumbPath(fileId), { force: true });
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

/** Delete thumbnails/<id>.webp files with no matching File row. Returns count removed. */
export async function purgeOrphanThumbs(): Promise<number> {
  const names = await fsp.readdir(paths.thumbnails).catch(() => [] as string[]);
  const stems = names.filter((n) => /^[0-9a-f]{64}\.webp$/.test(n)).map((n) => n.slice(0, -5));
  if (stems.length === 0) return 0;
  const keep = new Set((await db.file.findMany({ select: { id: true } })).map((f) => f.id));
  let n = 0;
  for (const s of stems) {
    if (!keep.has(s)) {
      await fsp.rm(thumbPath(s), { force: true });
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
