/** Pan/zoom state for a centred, `translate(x,y) scale(zoom)` element (origin at its centre). */
export type ZoomState = { zoom: number; x: number; y: number };

export const ZOOM_RESET: ZoomState = { zoom: 1, x: 0, y: 0 };

export type ZoomLimits = {
  min?: number;
  max?: number;
  /** reaching `min` recentres the pan (viewer: zoomed all the way out = fit) */
  snapAtMin?: boolean;
};

/**
 * Zoom by `factor` keeping the screen point `p` fixed. `p` is measured from the
 * element's transform origin (the viewer uses its centre, boards their top-left).
 * Zoom is clamped to [min, max] (default 1–16, snapping back to centre at min).
 */
export function zoomAt(
  s: ZoomState,
  p: { x: number; y: number },
  factor: number,
  { min = 1, max = 16, snapAtMin = true }: ZoomLimits = {},
): ZoomState {
  const zoom = Math.min(max, Math.max(min, s.zoom * factor));
  if (snapAtMin && zoom <= min) return { zoom: min, x: 0, y: 0 };
  const k = zoom / s.zoom;
  return { zoom, x: p.x - (p.x - s.x) * k, y: p.y - (p.y - s.y) * k };
}

/** Zoom to an absolute level around `p` (e.g. 1:1 pixels on double-click). */
export function zoomTo(s: ZoomState, p: { x: number; y: number }, zoom: number, limits?: ZoomLimits): ZoomState {
  return zoomAt(s, p, zoom / s.zoom, limits);
}

/** Largest box with aspect `w/h` that fits inside `box` (CSS object-fit: contain, no upscaling). */
export function fitContain(w: number, h: number, box: { width: number; height: number }) {
  const k = Math.min(box.width / w, box.height / h, 1);
  return { width: w * k, height: h * k };
}
