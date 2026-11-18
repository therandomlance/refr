"use client";

import { useMemo, useState } from "react";
import { api } from "refr/trpc/react";
import { Icon } from "refr/app/_components/icon";
import { ConfirmDialog } from "refr/app/_components/dialog";
import { staticSuggestionOptions } from "refr/app/_components/tag-actions";
import { usePersistentBoolean } from "refr/lib/persistent-state";

/**
 * Right-hand pane: images like the board as a whole (kNN on the mean embedding
 * of its images). ✓ adds to the board, ✕ hides from this board's suggestions;
 * "Reset hidden" clears that list. Only shown while CLIP is ready.
 */
export function BoardSuggestions({
  fileIds,
  hidden,
  onAdd,
  onHide,
  onResetHidden,
  onOpen,
}: {
  fileIds: string[];
  hidden: string[];
  onAdd: (fileId: string) => void;
  onHide: (fileId: string) => void;
  onResetHidden: () => void;
  onOpen: (fileIds: string[], fileId: string) => void;
}) {
  const ml = api.ml.status.useQuery();
  const ready = ml.data?.state === "ready";
  const [open, setOpen] = usePersistentBoolean("refr:boards:suggestions-open", () => true);
  const [confirmReset, setConfirmReset] = useState(false);
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
    <aside className="board-suggest" aria-label="Suggested images">
      <div className="board-suggest-head">
        <span className="text-xs font-semibold">Suggested</span>
        <span className="text-xs text-fg-subtle">{items.length}</span>
        <button title="Refresh suggestions" aria-label="Refresh suggestions" className="ml-auto text-fg-muted" disabled={q.isFetching} onClick={() => void q.refetch()}>↻</button>
        <button className="rail-btn" style={{ width: 24, height: 24 }} title="Hide suggestions" aria-label="Hide suggestions" onClick={() => setOpen(false)}>
          <Icon name="right" />
        </button>
      </div>
      {hidden.length > 0 && (
        <button className="btn mx-3 mb-2" style={{ fontSize: 12 }} onClick={() => setConfirmReset(true)}>
          Reset hidden ({hidden.length})
        </button>
      )}
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
      {confirmReset && (
        <ConfirmDialog
          title="Reset hidden suggestions"
          body={<>Show the {hidden.length} hidden image{hidden.length === 1 ? "" : "s"} in this board’s suggestions again?</>}
          confirmLabel="Reset"
          danger
          onConfirm={onResetHidden}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </aside>
  );
}
