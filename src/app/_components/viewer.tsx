"use client";
import { Icon } from "./icon";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "refr/trpc/react";
import { useViewerList } from "./viewer-store";
import { TagInput } from "./tag-input";
import { ConfirmDialog } from "./dialog";
import { formatDuration } from "./media-grid";
import { usePersistentBoolean } from "refr/lib/persistent-state";
import { useTagEdit } from "./tag-actions";
import { useActionFeedback } from "./action-feedback";
import { copyText } from "refr/lib/clipboard";
import type { FileSummary } from "refr/server/services/search";

/** gap between adjacent panes in the swipe track, px */
const PANE_GAP = 16;
const SNAP_MS = 220;

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

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
  const { items, loadMore, hasMore } = useViewerList();
  const notify = useActionFeedback();
  // ponytail: side panels + carousel remember their open/closed state across viewer
  // reopens and reloads. Defaults: left closed, right open on tablet+, closed on phone,
  // carousel open.
  const [leftOpen, setLeftOpen] = usePersistentBoolean("refr:viewer-left", () => false);
  const [rightOpen, setRightOpen] = usePersistentBoolean("refr:viewer-right", () =>
    typeof window === "undefined" || window.innerWidth >= 640,
  );
  const [carouselOpen, setCarouselOpen] = usePersistentBoolean("refr:viewer-carousel", () => true);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // phone layout: the thumbnail strip lives in a bottom-sheet popup instead of over the image
  const isPhone = useMediaQuery("(max-width: 640px)");
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { if (!isPhone) setSheetOpen(false); }, [isPhone]);
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sheetOpen) sheetRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }, [sheetOpen]);

  // Swipe track: prev / current / next panes slide with the finger. Transforms are
  // written straight to the DOM during a drag so moves don't re-render React.
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; axis: "x" | "y" | null; dx: number; lastX: number; lastT: number; v: number } | null>(null);
  const pendingNav = useRef<number | null>(null);
  const settling = useRef(false);

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
  // session mode may repeat a file, so trust the controlled index there
  const baseIndex = onNavigate && controlledIndex !== undefined ? controlledIndex : listIndex;
  const prevItem = baseIndex > 0 ? items[baseIndex - 1] : undefined;
  const nextItem = baseIndex >= 0 ? items[baseIndex + 1] : undefined;
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

  // Warm the browser cache with the neighbouring originals so arrow navigation
  // doesn't wait on a full download (videos are skipped — too heavy to prefetch).
  // ponytail: no cancellation — fast scrubbing may leave a few stale fetches running.
  const prevId = items[listIndex - 1]?.mediaType === "image" ? items[listIndex - 1]!.id : null;
  const nextId = items[listIndex + 1]?.mediaType === "image" ? items[listIndex + 1]!.id : null;
  useEffect(() => {
    if (listIndex < 0) return;
    for (const id of [nextId, prevId]) {
      if (!id) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = `/api/file/${id}`;
    }
  }, [listIndex, prevId, nextId]);

  const copyPath = (path: string) => {
    void copyText(path).then((ok) =>
      notify(ok ? { message: "Path copied." } : { message: "Could not copy to the clipboard.", error: true }),
    );
  };

  const keyHandler = useCallback(
    (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (sheetOpen) {
        if (e.key === "Escape") setSheetOpen(false);
        return;
      }
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
    [items, listIndex, onClose, controlledIndex, onNavigate, sheetOpen],
  );
  useEffect(() => {
    window.addEventListener("keydown", keyHandler);
    return () => window.removeEventListener("keydown", keyHandler);
  }, [keyHandler]);

  const currentFile = file.data;
  // Fall back to the list's media type so a swiped-in image shows immediately instead of
  // flashing "Loading…". Session lists claim "image" for everything; a video there just
  // shows its thumbnail (PaneImage's error fallback) until the file query resolves.
  const mediaType = currentFile?.mediaType ?? items[baseIndex]?.mediaType;
  const isVideo = mediaType === "video";

  const setTrack = (px: number, ms = 0) => {
    const el = trackRef.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.75,.3,1)` : "none";
    el.style.transform = px ? `translate3d(${px}px,0,0)` : "";
  };
  const finishSwipe = () => {
    const dir = pendingNav.current;
    if (dir == null) return;
    pendingNav.current = null;
    nav(dir); // the layout effect below re-centres the track once the new id renders
    // safety net if navigation didn't actually change the item
    window.setTimeout(() => {
      if (!settling.current) return;
      settling.current = false;
      setTrack(0);
    }, 300);
  };
  // after navigation commits, the pane that slid into the middle is now the "cur" pane
  // at 0 — reset the track in the same frame so nothing visibly jumps
  useLayoutEffect(() => {
    if (!settling.current) return;
    settling.current = false;
    setTrack(0);
  }, [currentId, controlledIndex]);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.target as HTMLElement;
    if (
      pendingNav.current != null || e.touches.length > 1 ||
      (window.visualViewport?.scale ?? 1) > 1.01 || // pinch-zoomed: let the browser pan
      t.closest("button, input, a, .carousel")
    ) {
      drag.current = null;
      return;
    }
    const p = e.touches[0]!;
    drag.current = { x: p.clientX, y: p.clientY, axis: null, dx: 0, lastX: p.clientX, lastT: e.timeStamp, v: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    if (!d) return;
    if (e.touches.length > 1) {
      drag.current = null;
      setTrack(0, SNAP_MS);
      return;
    }
    const p = e.touches[0]!;
    const dx = p.clientX - d.x;
    const dy = p.clientY - d.y;
    if (!d.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (d.axis !== "x") return;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = 0.8 * ((p.clientX - d.lastX) / dt) + 0.2 * d.v;
    d.lastX = p.clientX;
    d.lastT = e.timeStamp;
    // rubber-band past either end of the list
    d.dx = (dx < 0 ? nextItem : prevItem) ? dx : dx * 0.25;
    setTrack(d.dx);
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.axis !== "x") return;
    const width = trackRef.current?.clientWidth ?? window.innerWidth;
    const dir = d.dx < 0 ? 1 : -1;
    const target = dir > 0 ? nextItem : prevItem;
    const flung = Math.abs(d.v) > 0.45 && Math.sign(d.v) === Math.sign(d.dx) && Math.abs(d.dx) > 24;
    if (!target || !(Math.abs(d.dx) > width * 0.22 || flung)) {
      setTrack(0, SNAP_MS);
      return;
    }
    pendingNav.current = dir;
    settling.current = true;
    if (reduceMotion) {
      finishSwipe();
      return;
    }
    // finish the slide at the finger's speed (clamped) so a fast fling doesn't decelerate
    const remaining = width + PANE_GAP - Math.abs(d.dx);
    const ms = Math.round(Math.min(SNAP_MS, Math.max(120, remaining / Math.max(Math.abs(d.v), 0.1))));
    setTrack(-dir * (width + PANE_GAP), ms);
    // transitionend can be skipped (hidden tab, interrupted transition)
    window.setTimeout(finishSwipe, ms + 80);
  };

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
  // ponytail: the phone sheet shows a wider window around the current item, not the whole list
  const sheetStart = Math.max(0, baseIndex - 60);
  const sheetItems = sheetOpen ? items.slice(sheetStart, Math.min(items.length, baseIndex + 61)) : [];
  const jumpTo = (id: string, index = items.findIndex((x) => x.id === id)) =>
    onNavigate ? onNavigate(index) : setId(id);

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
          <div className="mt-3 flex flex-wrap gap-2">
            <a className="btn" href={`/api/file/${currentFile.id}`} target="_blank" rel="noopener noreferrer">Open original</a>
            <a className="btn" href={`/api/file/${currentFile.id}`} download={currentFile.paths[0]?.path.split("/").pop() ?? true}>Download</a>
          </div>
          <h3>Paths</h3>
          {currentFile.paths.map((p) => (
            <button
              type="button"
              key={p.id}
              className="vpath mb-1 block w-full text-left text-xs break-all"
              title="Copy path"
              onClick={() => copyPath(p.path)}
            >
              {p.path}
            </button>
          ))}
          <h3>ID</h3>
          <div className="text-xs break-all text-fg-subtle">{currentFile.id}</div>
        </div>
      )}

      {/* clicking the dark backdrop (the stage itself, not the media/controls) closes;
          not in session mode (onNavigate) — a misclick shouldn't kill a timed session */}
      <div
        className="stage"
        data-backdrop=""
        onClick={(e) => !onNavigate && (e.target as HTMLElement).dataset.backdrop !== undefined && onClose()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => { if (drag.current) { drag.current = null; setTrack(0, SNAP_MS); } }}
      >
        <div
          className="vtrack"
          ref={trackRef}
          data-backdrop=""
          onTransitionEnd={(e) => { if (e.target === e.currentTarget) finishSwipe(); }}
        >
          {/* keyed by list position so the pane sliding in keeps its <img> element when it
              becomes current — no reload/flash at the end of a swipe */}
          {prevItem && (
            <div key={baseIndex - 1} className="vpane prev" aria-hidden="true">
              <PaneImage key={prevItem.id} id={prevItem.id} mediaType={prevItem.mediaType} />
            </div>
          )}
          <div key={baseIndex} className="vpane cur" data-backdrop="">
            {mediaType === "image" ? (
              <PaneImage key={currentId} id={currentId} mediaType="image" />
            ) : file.isLoading ? <p role="status" className="state-message">Loading image…</p> : file.isError ? (
              <div role="alert" className="state-message">Could not load this file. <button className="btn" onClick={() => void file.refetch()}>Try again</button></div>
            ) : isVideo ? (
              <video key={currentId} src={`/api/file/${currentId}`} controls autoPlay />
            ) : null}
          </div>
          {nextItem && (
            <div key={baseIndex + 1} className="vpane next" aria-hidden="true">
              <PaneImage key={nextItem.id} id={nextItem.id} mediaType={nextItem.mediaType} />
            </div>
          )}
        </div>
        {overlayTop}
        {!onNavigate && listIndex >= 0 && items.length > 1 && (
          <div className="vpos" aria-live="polite">{listIndex + 1} / {items.length}{hasMore ? "+" : ""}</div>
        )}
        <button className="vbtn" aria-label="Close viewer" style={{ top: 14, right: 14 }} onClick={onClose}><Icon name="close" /></button>
        <button className="vbtn" style={{ top: 14, left: 14 }} onClick={() => setLeftOpen(!leftOpen)} title="Info" aria-label="Toggle file information" aria-expanded={leftOpen}><Icon name="info" /></button>
        <button className="vbtn" style={{ top: 14, right: 60 }} onClick={() => setRightOpen(!rightOpen)} title="Tags" aria-label="Toggle tags" aria-expanded={rightOpen}><Icon name="tag" /></button>
        <button className="nav prev" aria-label="Previous image" style={{ left: 18 }} onClick={() => nav(-1)}><Icon name="left" /></button>
        <button className="nav next" aria-label="Next image" style={{ right: 18 }} onClick={() => nav(1)}><Icon name="right" /></button>
        {!isPhone && carouselOpen && items.length > 1 && (
          <div className="carousel" onClick={(e) => e.stopPropagation()}>
            {carouselItems.map((it) => (
              <button type="button"
                key={it.id}
                aria-label={`Open image ${items.indexOf(it) + 1}`}
                aria-current={it.id === currentId ? "true" : undefined}
                onClick={() => jumpTo(it.id)}
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
        {isPhone ? (
          items.length > 1 && (
            <button
              className="vbtn vsheet-toggle"
              onClick={() => setSheetOpen(true)}
              aria-label="Show all images"
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
            >
              <Icon name="grid" />
            </button>
          )
        ) : (
          <button
            className="vbtn"
            style={{ bottom: carouselOpen ? 100 : 14, left: "50%", transform: "translateX(-50%)", width: 30, height: 20, borderRadius: 4, fontSize: 11 }}
            onClick={() => setCarouselOpen(!carouselOpen)}
            aria-label="Toggle image strip"
            aria-expanded={carouselOpen}
          >
            <Icon name={carouselOpen ? "down" : "up"} />
          </button>
        )}
      </div>

      {sheetOpen && (
        <div className="vsheet-bg" onClick={() => setSheetOpen(false)}>
          <div className="vsheet" role="dialog" aria-modal="true" aria-label="Images" onClick={(e) => e.stopPropagation()}>
            <div className="vsheet-head">
              <span>{baseIndex + 1} / {items.length}{hasMore ? "+" : ""}</span>
              <button className="vbtn" aria-label="Close image list" onClick={() => setSheetOpen(false)}><Icon name="close" /></button>
            </div>
            <div className="vsheet-grid" ref={sheetRef}>
              {sheetItems.map((it, j) => {
                const i = sheetStart + j;
                const cur = i === baseIndex;
                return (
                  <button type="button"
                    key={`${i}`}
                    aria-label={`Open image ${i + 1}`}
                    aria-current={cur ? "true" : undefined}
                    className={cur ? "cur" : ""}
                    onClick={() => { jumpTo(it.id, i); setSheetOpen(false); }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/thumb/${it.id}`} alt="" loading="lazy" />
                  </button>
                );
              })}
            </div>
            {hasMore && loadMore && (
              <button className="btn mt-3 w-full" onClick={() => loadMore()}>Load more</button>
            )}
          </div>
        </div>
      )}

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
                  className="chip cursor-pointer border border-dashed border-line-strong"
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

/** Image in a swipe-track pane: the original for images (neighbours are already
 *  prefetched), the thumbnail for anything else or if the original can't render.
 *  Used for the current AND neighbour panes so the element survives becoming current. */
function PaneImage({ id, mediaType }: { id: string; mediaType: FileSummary["mediaType"] }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={mediaType === "image" ? `/api/file/${id}` : `/api/thumb/${id}`}
      alt=""
      draggable={false}
      onError={(e) => {
        const img = e.currentTarget;
        if (img.dataset.fallback) return;
        img.dataset.fallback = "1";
        img.src = `/api/thumb/${id}`;
      }}
    />
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
