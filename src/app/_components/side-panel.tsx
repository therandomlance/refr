"use client";

import { useState } from "react";

/** Collapsible left sidebar (browse/search/queue). Collapsed = slim expand strip. */
export function SidePanel({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <div
        className="flex w-8 flex-none flex-col items-center pt-3"
        style={{ background: "var(--panel)", borderRight: "1px solid var(--border)" }}
      >
        <button
          className="rail-btn"
          style={{ width: 24, height: 24, fontSize: 12 }}
          title="Show sidebar"
          onClick={() => setOpen(true)}
        >
          »
        </button>
      </div>
    );
  }
  return (
    <aside
      className="scroll-thin flex w-60 flex-none flex-col overflow-y-auto"
      style={{ background: "var(--panel)", borderRight: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">{head}</div>
        <button
          className="rail-btn flex-none"
          style={{ width: 22, height: 22, fontSize: 12 }}
          title="Hide sidebar"
          onClick={() => setOpen(false)}
        >
          «
        </button>
      </div>
      {children}
    </aside>
  );
}
