import { buildRows, PAD, type GridRow } from "./grid-rows";
import type { FileSummary } from "refr/server/services/search";
import type { TimelineBucket } from "./timeline";

type LayoutRow = GridRow | { type: "placeholder"; height: number };
export type TimelineRow = LayoutRow & { monthIndex: number };
export type TimelineLayout = ReturnType<typeof buildTimelineLayout>;
const HEADER_HEIGHT = 56; // 28px check button + 18px/10px header padding

export function timelineRowHeight(row: LayoutRow, gap: number): number {
  return row.type === "header" ? HEADER_HEIGHT : row.type === "placeholder" ? row.height : row.height + 2 * PAD + gap;
}

export function buildTimelineLayout({ buckets, months, width, rowH, gap, grouping }: {
  buckets: TimelineBucket[];
  months: (FileSummary[] | undefined)[];
  width: number;
  rowH: number;
  gap: number;
  grouping: "day" | "month" | "year";
}) {
  const rows: TimelineRow[] = [];
  let top = 0;
  const positions = buckets.map((bucket, monthIndex) => {
    const items = months[monthIndex];
    // ponytail: estimate unloaded rows at 3:2 aspect; replace with actual geometry on load.
    const perRow = Math.max(1, Math.floor((width - 36) / (rowH * 1.5 + 2 * PAD + gap)));
    const yearContinuation = grouping === "year" && buckets[monthIndex - 1]?.year === bucket.year;
    const estimatedHeight = Math.ceil(bucket.count / perRow) * (rowH + 2 * PAD + gap)
      + (grouping === "day" ? Math.min(bucket.count, 31) : yearContinuation ? 0 : 1) * HEADER_HEIGHT;
    const monthRows: (GridRow | { type: "placeholder"; height: number })[] = items
      ? buildRows({ items, width, rowH, gap, grouping, doGrouping: true }).filter((row) => !yearContinuation || row.type !== "header")
      : [{ type: "placeholder", height: estimatedHeight }];
    if (grouping === "year" && !yearContinuation && monthRows[0]?.type === "header") {
      monthRows[0].segs[0]!.ids = months.flatMap((files, i) => buckets[i]?.year === bucket.year ? files?.map((f) => f.id) ?? [] : []);
    }
    const height = monthRows.reduce((sum, row) => sum + timelineRowHeight(row, gap), 0);
    rows.push(...monthRows.map((row) => ({ ...row, monthIndex })));
    const position = { bucket, top, height };
    top += height;
    return position;
  });
  return { rows, positions, height: top };
}

/** Both directions use pixel geometry, never timestamp interpolation. */
export function timelinePosition(layout: TimelineLayout, offset: number) {
  const position = layout.positions.find((p) => offset < p.top + p.height) ?? layout.positions.at(-1);
  return position ? {
    year: position.bucket.year,
    month: position.bucket.month,
    fraction: position.height > 0 ? Math.max(0, Math.min(1, (offset - position.top) / position.height)) : 0,
  } : null;
}

export function timelineOffset(layout: TimelineLayout, position: { year: number; month: number; fraction: number }) {
  const month = layout.positions.find((p) => p.bucket.year === position.year && p.bucket.month === position.month);
  return month ? month.top + month.height * Math.max(0, Math.min(1, position.fraction)) : 0;
}
