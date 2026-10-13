"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { usePersistentBoolean } from "refr/lib/persistent-state";
import { Icon } from "./icon";

/** Collapsible left sidebar. Collapsed = slim expand strip.
 *  ponytail: on phones (<640px) the open state is a fixed drawer with a backdrop;
 *  on tablet+ it stays in-flow. State persists independently for each app section. */
export function SidePanel({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  const page = usePathname().split("/")[1] ?? "browse";
  return <PageSidePanel key={page} page={page} head={head}>{children}</PageSidePanel>;
}

function PageSidePanel({ page, head, children }: { page: string; head: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = usePersistentBoolean(`refr:sidepanel:${page}:open`, () =>
    typeof window === "undefined" || window.innerWidth >= 640,
  );
  const widthKey = `refr:sidepanel:${page}:width`;
  const [width, setWidth] = useState(240);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number) => {
    const next = Math.max(180, Math.min(600, value));
    setWidth(next);
    try { localStorage.setItem(widthKey, String(next)); } catch { /* storage unavailable */ }
  };
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(widthKey));
      if (Number.isFinite(stored) && stored >= 180 && stored <= 600) setWidth(stored);
    } catch { /* storage unavailable */ }
  }, [widthKey]);
  if (!open) {
    return (
      <div
        className="sidepanel-collapsed flex w-8 flex-none flex-col items-center pt-3"
        style={{ background: "var(--panel)", borderRight: "1px solid var(--border)" }}
      >
        <button
          className="rail-btn"
          style={{ width: 24, height: 24, fontSize: 12 }}
          title="Show sidebar"
          aria-label="Show sidebar"
          onClick={() => setOpen(true)}
        >
          <Icon name="right" />
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="sidepanel-backdrop" onClick={() => setOpen(false)} />
      <aside
        className="sidepanel flex min-h-0 flex-none"
        style={{ "--sidebar-width": `${width}px`, background: "var(--panel)", borderRight: "1px solid var(--border)" } as CSSProperties}
      >
        <div className="scroll-thin flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
            <div className="flex min-w-0 flex-1 items-center justify-between gap-2">{head}</div>
            <button
              className="rail-btn flex-none"
              style={{ width: 22, height: 22, fontSize: 12 }}
              title="Hide sidebar"
              aria-label="Hide sidebar"
              onClick={() => setOpen(false)}
            >
              <Icon name="left" />
            </button>
          </div>
          {children}
        </div>
        <div
          className="sidepanel-resize"
          role="separator"
          tabIndex={0}
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={180}
          aria-valuemax={600}
          aria-valuenow={width}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, width };
          }}
          onPointerMove={(e) => {
            if (drag.current) resize(drag.current.width + e.clientX - drag.current.x);
          }}
          onPointerUp={(e) => {
            drag.current = null;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onLostPointerCapture={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            resize(e.key === "Home" ? 180 : e.key === "End" ? 600 : width + (e.key === "ArrowLeft" ? -10 : 10));
          }}
        />
      </aside>
    </>
  );
}
