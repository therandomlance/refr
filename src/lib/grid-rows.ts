import type { FileSummary } from "refr/server/services/search";

export type HeaderSeg = { label: string; ids: string[]; width?: number };

export type GridRow =
  | { type: "header"; segs: HeaderSeg[] }
  | { type: "tiles"; files: FileSummary[]; height: number; groupSizes?: number[] };

export const SIZE_SCALE = { small: 1, medium: 1.5, large: 2.25 };

/** Gap between groups packed onto one row (bigger than the tile gap, for visibility). */
export const PACK_GAP = 16;
/** Padding around every thumb (per side). Tiles are laid out footprint = h*aspect + 2*PAD. */
export const PAD = 3;

/** Fixed-height footprint; crop panoramas only when a single tile cannot fit. */
export function tileWidth(file: FileSummary, height: number, available: number): number {
  const aspect = file.width && file.height ? file.width / file.height : 1;
  return Math.min(height * aspect + 2 * PAD, Math.max(2 * PAD + 1, available));
}

export function groupLabel(mtime: number, grouping: "day" | "month" | "year"): string {
  const d = new Date(mtime);
  if (grouping === "year") return String(d.getFullYear());
  if (grouping === "month") return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  // day grouping: include the year (drop the weekday) for dates outside the
  // current calendar year, so "Apr 11, 2024" is distinguishable from "Apr 11"
  if (d.getFullYear() !== new Date().getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Bucket key: like groupLabel but year-qualified for days (same "Aug 11" label, different years). */
function groupKey(mtime: number, grouping: "day" | "month" | "year"): string {
  if (grouping !== "day") return groupLabel(mtime, grouping);
  const d = new Date(mtime);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Fixed-height horizontal rows. When grouping: a group that fits on one row at
 * natural height is packed with other fitting groups (PACK_GAP between groups,
 * header label over each group's segment); a group too wide for a row gets
 * wrapped rows of its own. Ungrouped: one continuous wrapped partition.
 */
export function buildRows({
  items,
  width,
  rowH,
  gap,
  grouping,
  doGrouping,
}: {
  items: FileSummary[];
  width: number;
  rowH: number;
  gap: number;
  grouping: "day" | "month" | "year";
  doGrouping: boolean;
}): GridRow[] {
  const avail = width - 36; // page padding
  const out: GridRow[] = [];
  const natWidth = (files: FileSummary[], h: number) =>
    files.reduce((s, f) => s + tileWidth(f, h, avail), 0) + gap * (files.length - 1);

  // split into consecutive groups (single unlabeled group when not grouping)
  const groups: { label: string | null; files: FileSummary[] }[] = [];
  let lastKey: string | null = null;
  for (const f of items) {
    const g = doGrouping ? groupKey(f.mtime, grouping) : null;
    const last = groups[groups.length - 1];
    if (last && g === lastKey) {
      last.files.push(f);
    } else {
      groups.push({ label: g === null ? null : groupLabel(f.mtime, grouping), files: [f] });
      lastKey = g;
    }
  }

  /** Wrap before overflow; never stretch sparse or final rows. */
  const partition = (files: FileSummary[]) => {
    let cur: FileSummary[] = [];
    let sum = 0;
    const flush = () => {
      if (cur.length === 0) return;
      out.push({ type: "tiles", files: cur, height: rowH });
      cur = [];
      sum = 0;
    };
    for (const f of files) {
      const w = tileWidth(f, rowH, avail);
      if (cur.length && sum + gap + w > avail) flush();
      sum += (cur.length ? gap : 0) + w;
      cur.push(f);
    }
    flush();
  };

  let pack: { label: string; files: FileSummary[] }[] = [];
  let packW = 0;
  const flushPack = () => {
    if (pack.length === 0) return;
    out.push({
      type: "header",
      segs: pack.map((g) => ({ label: g.label, ids: g.files.map((f) => f.id), width: natWidth(g.files, rowH) })),
    });
    out.push({
      type: "tiles",
      files: pack.flatMap((g) => g.files),
      height: rowH,
      groupSizes: pack.map((g) => g.files.length),
    });
    pack = [];
    packW = 0;
  };

  for (const g of groups) {
    const w = natWidth(g.files, rowH);
    if (!doGrouping || w > avail) {
      flushPack();
      if (g.label !== null) out.push({ type: "header", segs: [{ label: g.label, ids: g.files.map((f) => f.id) }] });
      partition(g.files);
    } else if (packW + (pack.length > 0 ? PACK_GAP : 0) + w > avail) {
      flushPack();
      pack = [{ label: g.label!, files: g.files }];
      packW = w;
    } else {
      pack.push({ label: g.label!, files: g.files });
      packW += (pack.length > 1 ? PACK_GAP : 0) + w;
    }
  }
  flushPack();
  return out;
}
