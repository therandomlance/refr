import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "./dataDir";
import { readJson, safeName, writeJson } from "./jsonStore";
import { db } from "refr/server/db";

export const paletteSchema = z.object({
  name: z.string().min(1),
  colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(1).max(10),
  sourceFileId: z.string().optional(),
});

export type Palette = z.infer<typeof paletteSchema>;

export type PaletteEntry = Palette & { folder: string; mtime: number };

/** folder path, each segment filename-safe */
function folderPath(folder: string) {
  return path.join(paths.palettes, ...folder.split("/").filter(Boolean).map(safeName));
}

function fileFor(folder: string, name: string) {
  return path.join(folderPath(folder), safeName(name) + ".json");
}

/** Walk data/palettes incl. subfolders. Top-level files live in folder "". */
export function list(): { items: PaletteEntry[]; folders: string[] } {
  const items: PaletteEntry[] = [];
  const folders: string[] = [];
  const walkDir = (dir: string, folder: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const f = folder ? folder + "/" + e.name : e.name;
        folders.push(f);
        walkDir(full, f);
      } else if (e.name.endsWith(".json")) {
        try {
          const p = readJson(full, paletteSchema);
          if (p) items.push({ ...p, folder, mtime: fs.statSync(full).mtimeMs });
        } catch {
          // skip invalid files
        }
      }
    }
  };
  walkDir(paths.palettes, "");
  return { items, folders: folders.sort() };
}

/** "name", "name (2)", "name (3)", … — first one not taken in the folder. */
function uniqueName(folder: string, name: string): string {
  if (!fs.existsSync(fileFor(folder, name))) return name;
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!fs.existsSync(fileFor(folder, n))) return n;
  }
}

/** overwrite = editing an existing palette in place; otherwise a taken name gets " (N)". */
export function save(palette: Palette, folder: string, overwrite = false): string {
  const p = paletteSchema.parse(palette);
  const name = overwrite ? p.name : uniqueName(folder, p.name);
  writeJson(fileFor(folder, name), { ...p, name });
  return name;
}

export function remove(name: string, folder: string) {
  fs.rmSync(fileFor(folder, name), { force: true });
}

export function move(name: string, fromFolder: string, toFolder: string) {
  const src = fileFor(fromFolder, name);
  const data = readJson(src, paletteSchema);
  if (!data) throw new Error(`palette '${name}' not found`);
  const dest = uniqueName(toFolder, data.name);
  writeJson(fileFor(toFolder, dest), { ...data, name: dest });
  fs.rmSync(src, { force: true });
}

export function createFolder(folder: string) {
  fs.mkdirSync(folderPath(folder), { recursive: true });
}

export function renameFolder(from: string, to: string) {
  const dst = folderPath(to);
  if (fs.existsSync(dst)) throw new Error(`folder '${to}' already exists`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(folderPath(from), dst);
}

/** Moves the folder's palettes (incl. subfolders) to unfiled, then removes the dir. */
export function deleteFolder(folder: string) {
  for (const p of list().items.filter((p) => p.folder === folder || p.folder.startsWith(folder + "/"))) {
    const name = uniqueName("", p.name);
    writeJson(fileFor("", name), { name, colors: p.colors, sourceFileId: p.sourceFileId });
    fs.rmSync(fileFor(p.folder, p.name), { force: true });
  }
  fs.rmSync(folderPath(folder), { recursive: true, force: true });
}

// ---------------------------------------------------------------- extraction

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

type Pixel = [number, number, number];

/** Median-cut: recursively split the widest channel at the median, average buckets. */
function medianCut(pixels: Pixel[], buckets: number): Pixel[] {
  if (pixels.length === 0) return [];
  let boxes: Pixel[][] = [pixels];
  while (boxes.length < buckets) {
    // pick the box with the greatest channel range
    let best: Pixel[] | null = null;
    let bestRange = 0;
    let bestChannel = 0;
    for (const box of boxes) {
      if (box.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let min = 255, max = 0;
        for (const p of box) {
          if (p[c]! < min) min = p[c]!;
          if (p[c]! > max) max = p[c]!;
        }
        if (max - min > bestRange) {
          bestRange = max - min;
          best = box;
          bestChannel = c;
        }
      }
    }
    if (!best) break;
    const sorted = [...best].sort((a, b) => a[bestChannel]! - b[bestChannel]!);
    const mid = Math.floor(sorted.length / 2);
    boxes = boxes.filter((b) => b !== best);
    boxes.push(sorted.slice(0, mid), sorted.slice(mid));
  }
  return boxes.map((box) => {
    const sum = box.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
    return [sum[0] / box.length, sum[1] / box.length, sum[2] / box.length] as Pixel;
  });
}

function luminance(p: Pixel): number {
  return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
}

/** Extract N colors from a file via sharp → raw RGB ≤128px → median cut, sorted by luminance. */
export async function extract(fileId: string, n: number): Promise<string[]> {
  const file = await db.file.findUnique({
    where: { id: fileId },
    select: { paths: { select: { path: true }, take: 1 } },
  });
  const src = file?.paths[0]?.path;
  if (!src || !fs.existsSync(src)) throw new Error("file not available");
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(src)
    .resize(128, 128, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels: Pixel[] = [];
  for (let i = 0; i < data.length; i += info.channels) {
    pixels.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  }
  return medianCut(pixels, Math.max(1, Math.min(10, n)))
    .sort((a, b) => luminance(b) - luminance(a))
    .map(([r, g, b]) => toHex(r, g, b));
}
