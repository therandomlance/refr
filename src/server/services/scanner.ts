import "server-only";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "refr/server/db";
import * as config from "./config";
import { deleteThumb, enqueueThumbs, hasThumb } from "./thumbs";
import { enqueueEmbeddings } from "./ml";

const execFileP = promisify(execFile);

export const EXTENSIONS: Record<string, "image" | "video"> = {
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  avif: "image", bmp: "image", tiff: "image", svg: "image",
  mp4: "video", webm: "video", mkv: "video", mov: "video", avi: "video",
};

export type ScanProgress = {
  running: boolean;
  phase: string;
  processed: number;
  total: number;
};

const progress: ScanProgress = { running: false, phase: "", processed: 0, total: 0 };
export function scanStatus(): ScanProgress {
  return { ...progress };
}

async function* walk(dir: string): AsyncGenerator<{ path: string; size: number; mtime: Date }> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!(ext in EXTENSIONS)) continue;
      try {
        const st = await fsp.stat(full);
        yield { path: full, size: st.size, mtime: st.mtime };
      } catch {
        // vanished between readdir and stat
      }
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function probe(filePath: string, mediaType: "image" | "video") {
  if (mediaType === "image") {
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(filePath).metadata();
      return { width: meta.width, height: meta.height };
    } catch {
      return {};
    }
  }
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
    ]);
    const data = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const vs = data.streams?.find((s) => s.codec_type === "video");
    const duration = data.format?.duration ? parseFloat(data.format.duration) : undefined;
    return { width: vs?.width, height: vs?.height, duration };
  } catch {
    return {}; // ffprobe missing or failed — index anyway
  }
}

let running: Promise<void> | null = null;

/** Single-flight scan trigger. Returns the in-flight promise if already running. */
export function scanNow(): Promise<void> {
  running ??= runScan().finally(() => {
    running = null;
  });
  return running;
}

async function runScan() {
  progress.running = true;
  progress.processed = 0;
  progress.total = 0;
  progress.phase = "scanning";
  const touchedFiles = new Set<string>();
  try {
    const libraries = config.get().libraries.map((l) => path.resolve(l));

    // Pass 1: reconcile known paths (all libraries at once, batched)
    const known = await db.filePath.findMany({ select: { id: true, path: true, size: true, mtime: true } });
    const rehashQueue = new Map<number, string>(); // filePathId -> path
    const knownPaths = new Set<string>();
    for (const k of known) {
      knownPaths.add(k.path);
      const st = await fsp.stat(k.path).catch(() => null);
      if (!st) {
        await db.filePath.delete({ where: { id: k.id } });
        continue;
      }
      if (BigInt(st.size) !== k.size || st.mtime.getTime() !== k.mtime.getTime()) {
        rehashQueue.set(k.id, k.path);
      }
    }
    // Rehash drifted paths
    for (const [fpId, p] of rehashQueue) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      await hashAndAttach({ path: p, size: st.size, mtime: st.mtime }, fpId, touchedFiles);
      progress.processed++;
    }

    // Pass 2: walk libraries, hash unknown paths
    for (const lib of libraries) {
      progress.phase = `scanning ${lib}`;
      for await (const item of walk(lib)) {
        progress.total++;
        if (knownPaths.has(item.path)) continue; // already handled above
        await hashAndAttach(item, null, touchedFiles);
        progress.processed++;
      }
    }

    // Pass 3: update File.mtime = max mtime across current paths (touched files only)
    progress.phase = "finalizing";
    for (const fileId of touchedFiles) {
      const rows = await db.filePath.findMany({ where: { fileId }, select: { mtime: true } });
      if (rows.length === 0) continue;
      const max = rows.reduce((m, r) => (r.mtime > m ? r.mtime : m), rows[0]!.mtime);
      await db.file.update({ where: { id: fileId }, data: { mtime: max } });
    }

    await enqueueMissingThumbs();
    await enqueueEmbeddings(); // no-op when ML disabled
  } finally {
    progress.running = false;
    progress.phase = "";
  }
}

/**
 * Hash the file at `item.path`, then:
 * - hash unknown → create File (+probe) and attach path
 * - hash known → attach path to that File (repointing from the old File if content changed in place)
 */
async function hashAndAttach(
  item: { path: string; size: number; mtime: Date },
  existingPathId: number | null,
  touched: Set<string>,
) {
  let hash: string;
  try {
    hash = await hashFile(item.path);
  } catch {
    return; // unreadable
  }
  const ext = path.extname(item.path).slice(1).toLowerCase();
  const mediaType = EXTENSIONS[ext]!;

  const existing = await db.file.findUnique({ where: { id: hash }, select: { id: true } });
  if (!existing) {
    const probed = await probe(item.path, mediaType);
    await db.file.create({
      data: {
        id: hash,
        size: BigInt(item.size),
        mtime: item.mtime,
        mediaType,
        width: probed.width,
        height: probed.height,
        duration: "duration" in probed ? probed.duration : undefined,
      },
    });
  }
  touched.add(hash);

  const pathData = { size: BigInt(item.size), mtime: item.mtime, fileId: hash };
  if (existingPathId !== null) {
    const old = await db.filePath.update({ where: { id: existingPathId }, data: pathData });
    if (old.fileId !== hash) touched.add(old.fileId); // old file lost a path
  } else {
    await db.filePath.upsert({
      where: { path: item.path },
      create: { path: item.path, ...pathData },
      update: pathData,
    });
  }
}

async function enqueueMissingThumbs() {
  progress.phase = "thumbnails";
  const files = await db.file.findMany({
    select: { id: true, mediaType: true, paths: { select: { path: true }, take: 1 } },
  });
  const want = files.filter((f) => f.paths[0] && !hasThumb(f.id));
  progress.total = want.length;
  progress.processed = 0;
  enqueueThumbs(
    want.map((f) => ({ fileId: f.id, mediaType: f.mediaType, path: f.paths[0]!.path })),
  );
}

/** Purge: delete File rows with zero paths (+ their thumbnails). Returns count deleted. */
export async function purgeOrphans(): Promise<number> {
  const orphans = await db.file.findMany({
    where: { paths: { none: {} } },
    select: { id: true },
  });
  for (const o of orphans) deleteThumb(o.id);
  await db.file.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  return orphans.length;
}

export async function countOrphans(): Promise<number> {
  return db.file.count({ where: { paths: { none: {} } } });
}

/** Files with no path under any configured library (e.g. after removing a library). */
async function externalFiles(): Promise<{ id: string }[]> {
  const libs = config.get().libraries.map((l) => path.resolve(l) + path.sep);
  const files = await db.file.findMany({ select: { id: true, paths: { select: { path: true } } } });
  // ponytail: O(files×paths×libs) filter in JS — one-off maintenance op at single-user scale
  return files.filter((f) => !f.paths.some((p) => libs.some((l) => p.path.startsWith(l))));
}

export async function purgeExternal(): Promise<number> {
  const doomed = await externalFiles();
  for (const d of doomed) deleteThumb(d.id);
  await db.file.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
  return doomed.length;
}

export async function countExternal(): Promise<number> {
  return (await externalFiles()).length;
}
