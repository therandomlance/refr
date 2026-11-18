import { describe, expect, it } from "vitest";
import { boardSchema, boxCenter, clipToBox, cornerResize, resolveArrow, type Box } from "refr/lib/boards";

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};
const corner = (b: Box, sx: number, sy: number) => {
  const c = boxCenter(b);
  const t = (b.rot * Math.PI) / 180;
  const ox = (sx * b.w) / 2;
  const oy = (sy * b.h) / 2;
  return { x: c.x + ox * Math.cos(t) - oy * Math.sin(t), y: c.y + ox * Math.sin(t) + oy * Math.cos(t) };
};

describe("cornerResize", () => {
  it("each corner keeps the opposite corner fixed (unrotated, aspect locked)", () => {
    const b: Box = { x: 100, y: 100, w: 200, h: 100, rot: 0 };
    const se = cornerResize(b, "se", { x: 500, y: 300 }, 0.5);
    expect(se).toEqual({ x: 100, y: 100, w: 400, h: 200 });
    const nw = cornerResize(b, "nw", { x: 0, y: 50 }, 0.5);
    expect(nw.x + nw.w).toBeCloseTo(300); expect(nw.y + nw.h).toBeCloseTo(200);
    expect(nw.h / nw.w).toBeCloseTo(0.5);
    const ne = cornerResize(b, "ne", { x: 400, y: 50 }, 0.5);
    expect(ne.x).toBeCloseTo(100); expect(ne.y + ne.h).toBeCloseTo(200);
    const sw = cornerResize(b, "sw", { x: 0, y: 250 }, 0.5);
    expect(sw.x + sw.w).toBeCloseTo(300); expect(sw.y).toBeCloseTo(100);
  });

  it("rotated: the opposite corner stays put in world space", () => {
    const b: Box = { x: 0, y: 0, w: 200, h: 100, rot: 30 };
    const fixed = corner(b, -1, -1);
    const r = cornerResize(b, "se", { x: 400, y: 300 }, 0.5);
    near(corner({ ...r, rot: 30 }, -1, -1), fixed);
  });

  it("free aspect (text) and minimum size", () => {
    const b: Box = { x: 0, y: 0, w: 100, h: 100, rot: 0 };
    expect(cornerResize(b, "se", { x: 300, y: 50 })).toEqual({ x: 0, y: 0, w: 300, h: 50 });
    expect(cornerResize(b, "se", { x: -500, y: -500 })).toEqual({ x: 0, y: 0, w: 40, h: 40 });
  });
});

describe("arrows", () => {
  const box: Box = { x: 0, y: 0, w: 100, h: 50, rot: 0 };
  it("clipToBox exits through the right edge / corner, rotated too", () => {
    near(clipToBox(box, { x: 500, y: 25 }), { x: 100, y: 25 });
    near(clipToBox(box, { x: 50, y: -500 }, 5), { x: 50, y: -5 });
    near(clipToBox({ ...box, rot: 90 }, { x: 500, y: 25 }), { x: 75, y: 25 });
  });
  it("resolveArrow attaches to item edges and fails for missing items", () => {
    const boxes = (id: string) => (id === "a" ? box : id === "b" ? { x: 300, y: 0, w: 100, h: 50, rot: 0 } : null);
    const base = { id: "x", color: "fg", width: "m", heads: "end", dashed: false } as const;
    const r = resolveArrow({ ...base, from: { item: "a" }, to: { item: "b" } }, boxes, 0)!;
    near(r.from, { x: 100, y: 25 });
    near(r.to, { x: 300, y: 25 });
    near(resolveArrow({ ...base, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }, boxes)!.to, { x: 3, y: 4 });
    expect(resolveArrow({ ...base, from: { item: "gone" }, to: { x: 0, y: 0 } }, boxes)).toBeNull();
  });
});

describe("boardSchema", () => {
  it("defaults text styling and arrow style", () => {
    const b = boardSchema.parse({ items: [{ kind: "text", id: "t", x: 0, y: 0, w: 10, h: 10 }], arrows: [{ id: "a", from: { x: 0, y: 0 }, to: { item: "t" } }] });
    expect(b.items[0]).toMatchObject({ text: "", size: "m", color: "fg", bg: "card", align: "left" });
    expect(b.arrows[0]).toMatchObject({ color: "fg", width: "m", heads: "end", dashed: false });
  });
});
