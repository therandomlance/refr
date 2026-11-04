import { expect, it } from "vitest";
import { buildTimelineLayout, timelineOffset, timelinePosition, timelineRowHeight } from "refr/lib/timeline-layout";
import type { FileSummary } from "refr/server/services/search";

const buckets = [3, 2, 1].map((month) => ({ year: 2025, month, count: 600, minMtime: 0, maxMtime: 0 }));
const images = (month: number): FileSummary[] => Array.from({ length: 600 }, (_, i) => ({
  id: `${month}-${i}`, mediaType: "image", width: 100, height: 100, duration: null,
  mtime: new Date(2025, month - 1, 15).getTime(), // all 600 share a timestamp
}));
const options = { buckets, width: 1200, rowH: 200, gap: 4, grouping: "month" as const };

it("seeks anywhere in a dense/tied month and preserves the date/fraction when placeholders load", () => {
  const unloaded = buildTimelineLayout({ ...options, months: [] });
  const loaded = buildTimelineLayout({ ...options, months: [images(3), images(2)] });
  const target = { year: 2025, month: 2, fraction: 0.63 };
  const before = timelinePosition(unloaded, timelineOffset(unloaded, target))!;
  const after = timelinePosition(loaded, timelineOffset(loaded, before))!;
  expect(after.year).toBe(target.year);
  expect(after.month).toBe(target.month);
  expect(after.fraction).toBeCloseTo(target.fraction);
  expect(loaded.rows.filter((r) => r.type === "tiles").flatMap((r) => r.type === "tiles" ? r.files : [])).toHaveLength(1200);
  expect(loaded.rows.reduce((sum, row) => sum + timelineRowHeight(row, options.gap), 0)).toBe(loaded.height);
  expect(timelinePosition(loaded, loaded.height)).toEqual({ year: 2025, month: 1, fraction: 1 });
  expect(timelinePosition(loaded, -100)?.fraction).toBe(0);
  expect(timelinePosition(buildTimelineLayout({ ...options, buckets: [], months: [] }), 0)).toBeNull();
});

it("keeps one year header and includes all loaded files of the year in its selection", () => {
  const layout = buildTimelineLayout({ ...options, grouping: "year", months: [images(3), images(2), images(1)] });
  const headers = layout.rows.filter((r) => r.type === "header");
  expect(headers).toHaveLength(1);
  expect(headers[0]?.type === "header" && headers[0].segs[0]?.ids).toHaveLength(1800);
});

it.each(["day", "month", "year"] as const)("reserves the unloaded remainder after a first-page preview (%s)", (grouping) => {
  const month = images(3);
  const partial = buildTimelineLayout({ ...options, grouping, months: [month.slice(0, 200)], partialMonths: [true] });
  const prefix = partial.rows.filter((r) => r.monthIndex === 0);
  expect(prefix.flatMap((r) => r.type === "tiles" ? r.files : [])).toEqual(month.slice(0, 200));
  const tail = prefix.at(-1)!;
  expect(tail.type).toBe("placeholder");
  expect(timelineRowHeight(tail, options.gap)).toBeGreaterThan(0);
  expect(partial.positions[1]!.top).toBe(prefix.reduce((sum, r) => sum + timelineRowHeight(r, options.gap), 0));
  const target = { year: 2025, month: 3, fraction: 0.75 };
  expect(timelinePosition(partial, timelineOffset(partial, target))?.fraction).toBeCloseTo(0.75);

  const loaded = buildTimelineLayout({ ...options, grouping, months: [month], partialMonths: [false] });
  expect(loaded.rows.filter((r) => r.monthIndex === 0).some((r) => r.type === "placeholder")).toBe(false);
  expect(loaded.rows.flatMap((r) => r.type === "tiles" ? r.files : [])).toEqual(month);
});
