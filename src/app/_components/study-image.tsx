"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitContain, zoomAt, zoomTo, ZOOM_RESET, type ZoomState } from "refr/lib/zoom";
import { studyFilter, type StudyTools } from "./study-tools";

/** SVG filters for the value-step (notan) view: luminance → N discrete levels.
 *  Rendered once by the viewer; referenced from CSS as url(#refr-value-N). */
export function StudyFilterDefs() {
  const levels = (n: number) => Array.from({ length: n }, (_, i) => (i / (n - 1)).toFixed(3)).join(" ");
  const lum = "0.2126 0.7152 0.0722 0 0";
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
      <defs>
        {[2, 3, 5].map((n) => (
          <filter key={n} id={`refr-value-${n}`} colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={`${lum} ${lum} ${lum} 0 0 0 1 0`} />
            <feComponentTransfer>
              <feFuncR type="discrete" tableValues={levels(n)} />
              <feFuncG type="discrete" tableValues={levels(n)} />
              <feFuncB type="discrete" tableValues={levels(n)} />
            </feComponentTransfer>
          </filter>
        ))}
      </defs>
    </svg>
  );
}

const GRID_LINES: Record<Exclude<StudyTools["grid"], "off">, number[]> = {
  thirds: [100 / 3, 200 / 3],
  "4x4": [25, 50, 75],
};

/** Composition grid over an image box (viewer + board tiles). Stroke widths are
 *  divided by the `--zoom` CSS variable an ancestor sets, so lines stay thin. */
export function GridOverlay({ grid }: { grid: StudyTools["grid"] }) {
  if (grid === "off") return null;
  const lines = GRID_LINES[grid];
  return (
    <svg className="vgrid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {(["under", "over"] as const).map((layer) => (
        <g key={layer} className={layer}>
          {lines.map((v) => (
            <g key={v}>
              <line x1={v} y1={0} x2={v} y2={100} vectorEffect="non-scaling-stroke" />
              <line x1={0} y1={v} x2={100} y2={v} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}

/**
 * The current viewer image with study tools applied: flip, filters, a composition
 * grid that tracks the image box, and wheel/drag/double-click zoom + pan.
 * Zoom state is owned by the viewer (it resets per image and has a hotkey).
 */
export function StudyImage({
  id,
  tools,
  zoom,
  setZoom,
}: {
  id: string;
  tools: StudyTools;
  zoom: ZoomState;
  setZoom: (z: ZoomState | ((prev: ZoomState) => ZoomState)) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const panDrag = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);

  // cached images can finish before React attaches onLoad
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) setNat({ w: img.naturalWidth, h: img.naturalHeight });
  }, [id]);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    // the element's own window: inside the pop-out reference window it's another document
    const RO = el.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver;
    const ro = new RO(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // native listener: React's onWheel is passive and can't preventDefault
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const p = { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
      setZoom((s) => zoomAt(s, p, Math.exp(-dy * 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  const fitted = nat && box ? fitContain(nat.w, nat.h, box) : null;
  const zoomed = zoom.zoom > 1;

  const onDoubleClick = (e: React.MouseEvent) => {
    if (zoomed) return setZoom(ZOOM_RESET);
    const r = frameRef.current!.getBoundingClientRect();
    const p = { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
    // 1:1 pixels; images already shown at native size get a plain 2×
    const oneToOne = nat && fitted ? nat.w / fitted.width : 2;
    setZoom((s) => zoomTo(s, p, oneToOne > 1.05 ? oneToOne : 2));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!zoomed || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panDrag.current = { x: e.clientX, y: e.clientY, sx: zoom.x, sy: zoom.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = panDrag.current;
    if (!d) return;
    setZoom((s) => ({ ...s, x: d.sx + e.clientX - d.x, y: d.sy + e.clientY - d.y }));
  };
  const endPan = () => { panDrag.current = null; };

  const transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.zoom})${tools.flip ? " scaleX(-1)" : ""}`;

  return (
    <div className="vstudy-frame" ref={frameRef} data-backdrop="">
      <div
        className={`vstudy${fitted ? "" : " pending"}${zoomed ? " zoomed" : ""}`}
        style={{ width: fitted?.width, height: fitted?.height, transform, "--zoom": zoom.zoom } as React.CSSProperties}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={`/api/file/${id}`}
          alt=""
          draggable={false}
          style={{ filter: studyFilter(tools) }}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={(e) => {
            const img = e.currentTarget;
            if (img.dataset.fallback) return;
            img.dataset.fallback = "1";
            img.src = `/api/thumb/${id}`;
          }}
        />
        {fitted && <GridOverlay grid={tools.grid} />}
      </div>
    </div>
  );
}
