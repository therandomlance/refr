"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean }
  | { label: string; submenu: { label: string; onClick: () => void }[] }
  | "sep";

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<number | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // defer: React can flush this effect while the opening contextmenu event is
    // still bubbling — adding listeners synchronously would close the menu instantly.
    // contextmenu uses capture so a right-click elsewhere closes-then-reopens the menu.
    const t = setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close, true);
      window.addEventListener("keydown", onKey);
      window.addEventListener("blur", close);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctxmenu" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
      {items.map((item, i) => {
        if (item === "sep") return <hr key={i} />;
        if ("submenu" in item) {
          // ponytail: submenu toggles on click (touch has no hover); edge-flip so it stays on-screen.
          // pos.x is the parent menu's left edge; if it's past the viewport midpoint, open to the left.
          const flipLeft = pos.x > window.innerWidth / 2;
          return (
            <div key={i} className="relative" onMouseEnter={() => setSub(i)} onMouseLeave={() => setSub(null)}>
              <button onClick={(e) => { e.stopPropagation(); setSub(sub === i ? null : i); }}>{item.label} ▸</button>
              {sub === i && (
                <div
                  className="ctxmenu"
                  style={{ position: "absolute", top: -4, [flipLeft ? "right" : "left"]: "100%" }}
                >
                  {item.submenu.map((s, j) => (
                    <button key={j} onClick={() => { s.onClick(); onClose(); }}>{s.label}</button>
                  ))}
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={i}
            style={item.danger ? { color: "#e66" } : undefined}
            onMouseEnter={() => setSub(null)}
            onClick={() => { item.onClick(); onClose(); }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
