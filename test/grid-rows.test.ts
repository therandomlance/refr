import { describe, expect, it } from "vitest";
import { buildRows, PACK_GAP, PAD, type GridRow } from "refr/lib/grid-rows";
import type { FileSummary } from "refr/server/services/search";

const DAY = 24 * 3600 * 1000;
const d0 = Date.UTC(2026, 0, 5, 12); // midday UTC: same local day in every tz

function img(id: string, mtime: number, w = 1000, h = 1000): FileSummary {
  return { id, mediaType: "image", width: w, height: h, duration: null, mtime };
}

function tiles(rows: GridRow[]) {
  return rows.filter((r): r is Extract<GridRow, { type: "tiles" }> => r.type === "tiles");
}
function headers(rows: GridRow[]) {
  return rows.filter((r): r is Extract<GridRow, { type: "header" }> => r.type === "header");
}

const OPTS = { width: 1200, rowH: 200, gap: 4, grouping: "day" as const };

describe("buildRows", () => {
  it("packs multiple small groups onto one row with per-group header segments", () => {
    // 3 days × 2 square images: footprint 416 each (2*(200+6)+4), two fit per 1164px row
    const items = [
      img("a1", d0), img("a2", d0),
      img("b1", d0 + DAY), img("b2", d0 + DAY),
      img("c1", d0 + 2 * DAY), img("c2", d0 + 2 * DAY),
    ];
    const rows = buildRows({ ...OPTS, items, doGrouping: true });
    const hs = headers(rows);
    const ts = tiles(rows);
    expect(hs).toHaveLength(2);
    expect(hs[0]!.segs).toHaveLength(2); // one segment per packed group
    expect(hs[0]!.segs[0]!.ids).toEqual(["a1", "a2"]);
    expect(hs[0]!.segs[1]!.ids).toEqual(["b1", "b2"]);
    expect(hs[1]!.segs).toHaveLength(1);
    expect(hs[1]!.segs[0]!.ids).toEqual(["c1", "c2"]);
    // segment widths match the group's footprint so labels sit over their tiles
    expect(hs[0]!.segs[0]!.width).toBe(2 * (200 + 2 * PAD) + 4);
    expect(ts).toHaveLength(2);
    expect(ts[0]!.groupSizes).toEqual([2, 2]);
    expect(ts[0]!.height).toBe(200); // natural height, not stretched
    expect(ts[1]!.groupSizes).toEqual([2]);
  });

  it("day labels are 'Mon, Jan 5' style (no year)", () => {
    const rows = buildRows({ ...OPTS, items: [img("a", d0)], doGrouping: true });
    const label = headers(rows)[0]!.segs[0]!.label;
    expect(label).toContain("Jan 5");
    expect(label).not.toContain("2026");
  });

  it("same day-label different year stays separate groups", () => {
    const items = [img("a", d0), img("b", d0 + 365 * DAY)];
    const rows = buildRows({ ...OPTS, items, doGrouping: true });
    // both fit one row easily, but they're different days → two segments
    expect(headers(rows)[0]!.segs).toHaveLength(2);
  });

  it("gives a too-wide group its own justified rows", () => {
    const items = Array.from({ length: 20 }, (_, i) => img(`f${i}`, d0));
    const rows = buildRows({ ...OPTS, items, doGrouping: true });
    const hs = headers(rows);
    const ts = tiles(rows);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.segs).toHaveLength(1);
    expect(hs[0]!.segs[0]!.ids).toHaveLength(20);
    expect(ts.length).toBeGreaterThan(1);
    expect(ts.every((t) => t.groupSizes === undefined)).toBe(true);
    // rows are justified to the container, height clamped
    expect(Math.max(...ts.map((t) => t.height))).toBeLessThanOrEqual(200 * 1.8);
  });

  it("ungrouped: no headers, single justified partition", () => {
    const items = [img("a", d0), img("b", d0 + DAY), img("c", d0 + 2 * DAY)];
    const rows = buildRows({ ...OPTS, items, doGrouping: false });
    expect(headers(rows)).toHaveLength(0);
    const ts = tiles(rows);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.files.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("a group exactly filling a row is not packed with a neighbor", () => {
    // 5 squares = 5*206+16 = 1046; adding another group (206) + PACK_GAP exceeds 1164
    const items = [
      ...Array.from({ length: 5 }, (_, i) => img(`a${i}`, d0)),
      img("b1", d0 + DAY),
    ];
    const rows = buildRows({ ...OPTS, items, doGrouping: true });
    const ts = tiles(rows);
    expect(ts).toHaveLength(2);
    expect(ts[0]!.groupSizes).toEqual([5]);
    expect(ts[1]!.groupSizes).toEqual([1]);
    expect(PACK_GAP).toBeGreaterThan(4); // gap wider than tile gap
  });
});
