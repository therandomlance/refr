"use client";

import { useMemo, useRef, type CSSProperties } from "react";
import { api } from "refr/trpc/react";
import { Icon } from "refr/app/_components/icon";
import { staticSuggestionOptions } from "refr/app/_components/tag-actions";
import { usePersistentBoolean, usePersistentNumber } from "refr/lib/persistent-state";

const MIN_W = 160;
const MAX_W = 600;

/**
 * Right-hand pane: images like the board as a whole (kNN on the mean embedding
 * of its images). ✓ adds to the board, ✕ hides from this board's suggestions
 * (cleared from the board's sidebar menu). Resizable like the left sidebar.
 * Only shown while CLIP is ready.
 */
export function BoardSuggestions({
  fileIds,
  hidden,
  onAdd,
  onHide,
  onOpen,
}: {
  fileIds: string[];
  hidden: string[];
  onAdd: (fileId: string) => void;
  onHide: (fileId: string) => void;
  onOpen: (fileIds: string[], fileId: string) => void;
}) {
  const ml = api.ml.status.useQuery();
  const ready = ml.data?.state === "ready";
  const [open, setOpen] = usePersistentBoolean("refr:boards:suggestions-open", () => true);
  const [width, setWidth] = usePersistentNumber("refr:boards:suggestions-width", 220, MIN_W, MAX_W);
  const resize = (w: number) => setWidth(Math.round(Math.max(MIN_W, Math.min(MAX_W, w))));
  const drag = useRef<{ x: number; width: number } | null>(null);
  // order-independent key: restacking items shouldn't refetch
  const key = useMemo(() => [...fileIds].sort(), [fileIds]);
  const q = api.ml.suggestImagesForFiles.useQuery(
    { fileIds: key },
    { ...staticSuggestionOptions, enabled: ready && open && key.length > 0, placeholderData: (prev) => prev },
  );
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const onBoard = useMemo(() => new Set(fileIds), [fileIds]);
  const items = (q.data ?? []).filter((s) => !hiddenSet.has(s.fileId) && !onBoard.has(s.fileId));

  if (!ready) return null;
  if (!open) {
    return (
      <div className="board-suggest collapsed">
        <button className="rail-btn" style={{ width: 28, height: 28 }} title="Show suggestions" aria-label="Show suggestions" onClick={() => setOpen(true)}>
          <Icon name="left" />
        </button>
      </div>
    );
  }
  return (
    <aside className="board-suggest" aria-label="Suggested images" style={{ "--suggest-width": `${width}px` } as CSSProperties}>
      {/* left-edge handle: dragging left widens the pane */}
      <div
        className="sidepanel-resize board-suggest-resize"
        role="separator"
        tabIndex={0}
        aria-label="Resize suggestions"
        aria-orientation="vertical"
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        aria-valuenow={width}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, width };
        }}
        onPointerMove={(e) => { if (drag.current) resize(drag.current.width - (e.clientX - drag.current.x)); }}
        onPointerUp={(e) => {
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onLostPointerCapture={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          resize(e.key === "Home" ? MIN_W : e.key === "End" ? MAX_W : width + (e.key === "ArrowLeft" ? 10 : -10));
        }}
      />
      <div className="board-suggest-head">
        <span className="text-xs font-semibold">Suggested</span>
        <span className="text-xs text-fg-subtle">{items.length}</span>
        <button title="Refresh suggestions" aria-label="Refresh suggestions" className="ml-auto text-fg-muted" disabled={q.isFetching} onClick={() => void q.refetch()}>↻</button>
        <button className="rail-btn" style={{ width: 24, height: 24 }} title="Hide suggestions" aria-label="Hide suggestions" onClick={() => setOpen(false)}>
          <Icon name="right" />
        </button>
      </div>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {key.length === 0 ? (
          <p className="text-xs text-fg-subtle">Add images to the board to get suggestions.</p>
        ) : q.isLoading ? (
          <p role="status" className="text-xs text-fg-subtle">Finding similar images…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-fg-subtle">No suggestions.</p>
        ) : (
          items.map((s) => (
            <div key={s.fileId} className="tile board-suggest-tile">
              <button type="button" className="tile-open" aria-label="Open suggested image" onClick={() => onOpen(items.map((i) => i.fileId), s.fileId)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/thumb/${s.fileId}`} alt="" loading="lazy" decoding="async" />
              </button>
              <button className="check review" title="Add to board" aria-label="Add to board" onClick={() => onAdd(s.fileId)}>
                <Icon name="check" />
              </button>
              <button className="deny review" title="Hide from suggestions" aria-label="Hide from suggestions" onClick={() => onHide(s.fileId)}>
                <Icon name="close" />
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
