import { describe, expect, it } from "vitest";
import { fitContain, zoomAt, zoomTo, ZOOM_RESET } from "refr/lib/zoom";

describe("zoomAt", () => {
  it("keeps the point under the cursor fixed", () => {
    const p = { x: 100, y: -40 };
    const s = zoomAt(ZOOM_RESET, p, 2);
    expect(s.zoom).toBe(2);
    // content point under p before: (p - t)/z = p. After: t + q*z must equal p.
    expect(s.x + p.x * s.zoom).toBeCloseTo(p.x);
    expect(s.y + p.y * s.zoom).toBeCloseTo(p.y);
    const s2 = zoomAt(s, p, 1.5);
    const q = { x: (p.x - s.x) / s.zoom, y: (p.y - s.y) / s.zoom };
    expect(s2.x + q.x * s2.zoom).toBeCloseTo(p.x);
    expect(s2.y + q.y * s2.zoom).toBeCloseTo(p.y);
  });

  it("clamps and recentres at the minimum", () => {
    expect(zoomAt({ zoom: 2, x: 50, y: 50 }, { x: 0, y: 0 }, 0.1)).toEqual(ZOOM_RESET);
    expect(zoomAt(ZOOM_RESET, { x: 0, y: 0 }, 100).zoom).toBe(16);
  });

  it("zoomTo reaches an absolute level", () => {
    expect(zoomTo({ zoom: 2, x: 0, y: 0 }, { x: 0, y: 0 }, 4).zoom).toBe(4);
  });
});

describe("fitContain", () => {
  it("fits without upscaling", () => {
    expect(fitContain(2000, 1000, { width: 1000, height: 1000 })).toEqual({ width: 1000, height: 500 });
    expect(fitContain(200, 100, { width: 1000, height: 1000 })).toEqual({ width: 200, height: 100 });
  });
});

describe("zoom limits", () => {
  it("boards can zoom out without recentring", () => {
    const s = zoomAt({ zoom: 1, x: 30, y: 30 }, { x: 100, y: 100 }, 0.5, { min: 0.1, max: 8, snapAtMin: false });
    expect(s.zoom).toBe(0.5);
    expect(s.x + ((100 - 30) / 1) * 0.5).toBeCloseTo(100);
  });
});
