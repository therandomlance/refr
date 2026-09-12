"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineBucket } from "refr/lib/timeline";

const PAD_TOP = 32; // room for the hover bubble above the track
const PAD_BOTTOM = 10;
const MIN_H = 3; // unclickable slivers for tiny months
const YEAR_GAP = 16; // min px between year labels
const DOT_GAP = 8; // min px between month dots

const monthLabel = (b: { year: number; month: number }) =>
  new Date(b.year, b.month - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

/**
 * Immich-style vertical time scrubber. Segments are months of the *whole*
 * filtered library (heights ∝ file count); the thumb tracks the topmost
 * visible month. Dragging/clicking a segment seeks the grid to that month.
 */
export function TimelineScrubber({
  buckets,
  active,
  onSeek,
}: {
  buckets: TimelineBucket[]; // newest first
  active: { year: number; month: number; fraction: number } | null;
  onSeek: (bucket: TimelineBucket, fraction: number) => void;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragFrac, setDragFrac] = useState(0);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const avail = Math.max(1, height - PAD_TOP - PAD_BOTTOM);

  const segments = useMemo(() => {
    if (buckets.length === 0) return [];
    const total = buckets.reduce((s, b) => s + b.count, 0) || 1;
    let hs = buckets.map((b) => Math.max(MIN_H, (b.count / total) * avail));
    const sum = hs.reduce((s, h) => s + h, 0) || 1;
    hs = hs.map((h) => (h * avail) / sum);
    const out: {
      bucket: TimelineBucket;
      top: number;
      height: number;
      hasLabel: boolean;
      hasDot: boolean;
    }[] = [];
    let top = 0;
    let labeledYear = buckets[0]!.year;
    let spanLabel = 0;
    let spanDot = 0;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]!;
      const h = hs[i]!;
      let hasLabel = false;
      let hasDot = false;
      if (i === 0) {
        hasLabel = true;
      } else {
        if (b.year !== labeledYear && spanLabel > YEAR_GAP) {
          hasLabel = true;
          labeledYear = b.year;
          spanLabel = 0;
        }
        if (h > 5 && spanDot > DOT_GAP) {
          hasDot = true;
          spanDot = 0;
        }
      }
      out.push({ bucket: b, top, height: h, hasLabel, hasDot });
      top += h;
      spanLabel += h;
      spanDot += h;
    }
    return out;
  }, [buckets, avail]);

  const activeIdx = useMemo(() => {
    if (!active) return -1;
    return buckets.findIndex((b) => b.year === active.year && b.month === active.month);
  }, [buckets, active]);

  const segIdxAt = (clientY: number): { idx: number; frac: number } | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const y = Math.max(0, Math.min(avail, clientY - rect.top));
    let acc = 0;
    for (let i = 0; i < segments.length; i++) {
      const h = segments[i]!.height;
      if (y < acc + h) return { idx: i, frac: h > 0 ? (y - acc) / h : 0 };
      acc += h;
    }
    const last = segments.length - 1;
    return last >= 0 ? { idx: last, frac: 1 } : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const hit = segIdxAt(e.clientY);
    if (!hit) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setDragIdx(hit.idx);
    setDragFrac(hit.frac);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const hit = segIdxAt(e.clientY);
    setHoverIdx(hit?.idx ?? null);
    if (dragging && hit) {
      setDragIdx(hit.idx);
      setDragFrac(hit.frac);
    }
  };
  const endDrag = (e: React.PointerEvent) => {
    if (dragging && dragIdx !== null) {
      const b = buckets[dragIdx];
      if (b) onSeek(b, dragFrac);
    }
    setDragging(false);
    setDragIdx(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const from = activeIdx >= 0 ? activeIdx : 0;
    const b = buckets[e.key === "ArrowUp" ? from - 1 : from + 1];
    if (b) onSeek(b, 0);
  };

  const idx = dragging ? dragIdx : hovering ? hoverIdx : null;
  const bubble = idx !== null ? segments[idx]?.bucket : undefined;
  const current =
    !dragging && !hovering && activeIdx >= 0 ? segments[activeIdx]?.bucket : undefined;
  const thumbTop =
    dragging && dragIdx !== null
      ? (segments[dragIdx]?.top ?? 0) + dragFrac * (segments[dragIdx]?.height ?? 0)
      : activeIdx >= 0
        ? (segments[activeIdx]?.top ?? 0) + active!.fraction * (segments[activeIdx]?.height ?? 0)
        : 0;

  return (
    <div
      ref={outerRef}
      className="tl-scrub"
      style={{ paddingTop: PAD_TOP, paddingBottom: PAD_BOTTOM }}
      role="scrollbar"
      tabIndex={0}
      aria-controls="tl-time-label"
      aria-valuetext={bubble ? monthLabel(bubble) : current ? monthLabel(current) : ""}
      aria-valuenow={Math.round(thumbTop)}
      aria-valuemax={Math.round(avail)}
      aria-valuemin={0}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false);
        setHoverIdx(null);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      {bubble && idx !== null && (
        <div id="tl-time-label" className="tl-bubble" style={{ top: (segments[idx]?.top ?? 0) + PAD_TOP - 8 }}>
          {monthLabel(bubble)}
        </div>
      )}
      {current && (
        <div id="tl-time-label" className="tl-current" style={{ top: thumbTop + PAD_TOP - 8 }}>
          {monthLabel(current)}
        </div>
      )}
      <div ref={trackRef} className="tl-track" style={{ height: avail }}>
        {segments.map((s, i) => (
          <div
            key={`${s.bucket.year}-${s.bucket.month}`}
            className="tl-seg"
            data-on={(dragging ? dragIdx : hoverIdx) === i ? "true" : "false"}
            style={{ height: s.height }}
          >
            {s.hasLabel && <span className="tl-year">{s.bucket.year}</span>}
            {s.hasDot && <span className="tl-dot" />}
          </div>
        ))}
        <div
          className="tl-thumb"
          style={{ top: thumbTop, opacity: dragging ? 0 : 1 }}
        />
      </div>
    </div>
  );
}
