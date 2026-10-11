"use client";
import { Icon } from "./icon";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "refr/trpc/react";
import { useViewerList } from "./viewer-store";
import { TagInput } from "./tag-input";
import { ConfirmDialog } from "./dialog";
import { formatDuration } from "./media-grid";
import { usePersistentBoolean } from "refr/lib/persistent-state";
import { useTagEdit } from "./tag-actions";

/**
 * Fullscreen viewer (§10.2). Left panel: metadata + options. Right: tag manager
 * + suggested tags. Bottom: carousel of surrounding items. ←/→ nav, Esc, `f`.
 */
export function Viewer({
  fileId,
  onClose,
  index: controlledIndex,
  onNavigate,
  overlayTop,
}: {
  fileId: string;
  onClose: () => void;
  /** session mode: navigation is caller-controlled */
  index?: number;
  onNavigate?: (index: number) => void;
  overlayTop?: React.ReactNode;
}) {
  const { items, loadMore } = useViewerList();
  // ponytail: side panels + carousel remember their open/closed state across viewer
  // reopens and reloads. Defaults: left closed, right open on tablet+, closed on phone,
  // carousel open.
  const [leftOpen, setLeftOpen] = usePersistentBoolean("refr:viewer-left", () => false);
  const [rightOpen, setRightOpen] = usePersistentBoolean("refr:viewer-right", () =>
    typeof window === "undefined" || window.innerWidth >= 640,
  );
  const [carouselOpen, setCarouselOpen] = usePersistentBoolean("refr:viewer-carousel", () => true);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // ponytail: swipe to navigate on touch — horizontal delta >50px beats vertical
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // local id state lets us swap images without re-mounting the viewer
  const [localId, setLocalId] = useState(fileId);
  useEffect(() => setLocalId(fileId), [fileId]);
  const setId = (id: string) => {
    setLocalId(id);
    const p = new URLSearchParams(window.location.search);
    p.set("v", id);
    window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
  };
  const currentId = onNavigate ? fileId : localId;

  const file = api.files.byId.useQuery({ id: currentId });
  const settings = api.settings.get.useQuery();
  const mlStatus = api.ml.status.useQuery();

  const tagsQ = api.tags.forFiles.useQuery({ fileIds: [currentId] });
  const suggestedQ = api.ml.suggestTagsForFile.useQuery(
    { fileId: currentId },
    { enabled: mlStatus.data?.state === "ready" },
  );
  const setTags = useTagEdit();

  // index of current file in the surrounding list
  const listIndex = items.findIndex((i) => i.id === currentId);
  const nav = (delta: number) => {
    if (onNavigate && controlledIndex !== undefined) {
      onNavigate(controlledIndex + delta);
      return;
    }
    const next = items[listIndex + delta];
    if (next) {
      setId(next.id);
      if (listIndex + delta > items.length - 10) loadMore?.();
    }
  };

  const keyHandler = useCallback(
    (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") nav(-1);
      else if (e.key === "ArrowRight") nav(1);
      else if (e.key === "Escape") onClose();
      else if (e.key === "f") {
        setLeftOpen((l) => {
          const next = !(l || rightOpen);
          setRightOpen(next);
          return next;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, listIndex, onClose, controlledIndex, onNavigate],
  );
  useEffect(() => {
    window.addEventListener("keydown", keyHandler);
    return () => window.removeEventListener("keydown", keyHandler);
  }, [keyHandler]);

  const currentFile = file.data;
  const isVideo = currentFile?.mediaType === "video";

  const removeTag = (tag: string) => {
    if (settings.data?.skipTagRemoveConfirm) {
      setTags.mutate({ fileIds: [currentId], add: [], remove: [tag] });
    } else {
      setConfirmRemove(tag);
    }
  };

  const carouselItems = items.slice(
    Math.max(0, listIndex - 10),
    Math.min(items.length, listIndex + 11),
  );

  return (
    <div className="viewer">
      {leftOpen && currentFile && (
        <div className="vside left" onClick={(e) => e.stopPropagation()}>
          <h3>Metadata</h3>
          <div className="kv"><span>Size</span><b>{formatBytes(Number(currentFile.size))}</b></div>
          {currentFile.width && currentFile.height && (
            <div className="kv"><span>Dimensions</span><b>{currentFile.width} × {currentFile.height}</b></div>
          )}
          {currentFile.duration != null && (
            <div className="kv"><span>Duration</span><b>{formatDuration(currentFile.duration)}</b></div>
          )}
          <div className="kv"><span>Date</span><b>{new Date(currentFile.mtime).toLocaleString()}</b></div>
          <div className="kv"><span>Added</span><b>{new Date(currentFile.addedAt).toLocaleString()}</b></div>
          <div className="kv"><span>Type</span><b>{currentFile.mediaType}</b></div>
          <h3>Paths</h3>
          {currentFile.paths.map((p) => (
            <div key={p.id} className="mb-1 text-xs break-all" style={{ color: "var(--text-dim)" }}>{p.path}</div>
          ))}
          <h3>ID</h3>
          <div className="text-xs break-all" style={{ color: "var(--text-faint)" }}>{currentFile.id}</div>
        </div>
      )}

      {/* clicking the dark backdrop (the stage itself, not the media/controls) closes;
          not in session mode (onNavigate) — a misclick shouldn't kill a timed session */}
      <div
        className="stage"
        onClick={(e) => !onNavigate && e.target === e.currentTarget && onClose()}
        onTouchStart={(e) => { touchStart.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY }; }}
        onTouchEnd={(e) => {
          if (!touchStart.current) return;
          const t = e.changedTouches[0]!;
          const dx = t.clientX - touchStart.current.x;
          const dy = t.clientY - touchStart.current.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) nav(dx < 0 ? 1 : -1);
          touchStart.current = null;
        }}
      >
        {overlayTop}
        <button className="vbtn" aria-label="Close viewer" style={{ top: 14, right: 14 }} onClick={onClose}><Icon name="close" /></button>
        <button className="vbtn" style={{ top: 14, left: 14 }} onClick={() => setLeftOpen(!leftOpen)} title="Info" aria-label="Toggle file information" aria-expanded={leftOpen}><Icon name="info" /></button>
        <button className="vbtn" style={{ top: 14, right: 60 }} onClick={() => setRightOpen(!rightOpen)} title="Tags" aria-label="Toggle tags" aria-expanded={rightOpen}><Icon name="tag" /></button>
        <button className="nav prev" aria-label="Previous image" style={{ left: 18 }} onClick={() => nav(-1)}><Icon name="left" /></button>
        {file.isLoading ? <p role="status" className="state-message">Loading image…</p> : file.isError ? (
          <div role="alert" className="state-message">Could not load this file. <button className="btn" onClick={() => void file.refetch()}>Try again</button></div>
        ) : isVideo ? (
          <video key={currentId} src={`/api/file/${currentId}`} controls autoPlay />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={currentId} src={`/api/file/${currentId}`} alt="" />
        )}
        <button className="nav next" aria-label="Next image" style={{ right: 18 }} onClick={() => nav(1)}><Icon name="right" /></button>
        {carouselOpen && items.length > 1 && (
          <div className="carousel" onClick={(e) => e.stopPropagation()}>
            {carouselItems.map((it) => (
              <button type="button"
                key={it.id}
                aria-label={`Open image ${items.indexOf(it) + 1}`}
                aria-current={it.id === currentId ? "true" : undefined}
                onClick={() => (onNavigate ? onNavigate(items.findIndex((x) => x.id === it.id)) : setId(it.id))}
              >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/thumb/${it.id}`}
                className={it.id === currentId ? "cur" : ""}
                alt=""
              />
              </button>
            ))}
          </div>
        )}
        <button
          className="vbtn"
          style={{ bottom: carouselOpen ? 100 : 14, left: "50%", transform: "translateX(-50%)", width: 30, height: 20, borderRadius: 4, fontSize: 11 }}
          onClick={() => setCarouselOpen(!carouselOpen)}
          aria-label="Toggle image strip"
          aria-expanded={carouselOpen}
        >
          <Icon name={carouselOpen ? "down" : "up"} />
        </button>
      </div>

      {rightOpen && (
        <div className="vside" onClick={(e) => e.stopPropagation()}>
          <h3>Tags</h3>
          <TagInput
            placeholder="Add tag…"
            onCommit={(raw) => {
              const tag = raw.replace(/^[-~=]+/, "");
              if (tag) setTags.mutate({ fileIds: [currentId], add: [tag], remove: [] });
            }}
          />
          <div className="mt-3">
            {(tagsQ.data ?? []).map((t) => (
              <span key={t} className="chip">
                {t}
                <button className="x" aria-label={`Remove tag ${t}`} onClick={() => removeTag(t)}><Icon name="close" /></button>
              </span>
            ))}
          </div>
          {mlStatus.data?.state === "ready" && (suggestedQ.data?.length ?? 0) > 0 && (
            <>
              <h3>Suggested</h3>
              {(suggestedQ.data ?? []).map((s) => (
                <button type="button"
                  key={s.tag}
                  className="chip"
                  style={{ cursor: "pointer", border: "1px dashed var(--border)" }}
                  onClick={() => setTags.mutate({ fileIds: [currentId], add: [s.tag], remove: [] })}
                  disabled={setTags.isPending}
                >
                  + {s.tag}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove tag"
          body={<>Remove <b>{confirmRemove}</b> from this file?</>}
          confirmLabel="Remove"
          onConfirm={() => setTags.mutate({ fileIds: [currentId], add: [], remove: [confirmRemove] })}
          onClose={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}
