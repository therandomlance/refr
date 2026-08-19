"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import type { FileSummary, Sort, Token } from "refr/server/services/search";
import { buildRows, PACK_GAP, PAD, type GridRow } from "refr/lib/grid-rows";
import { publishViewerList } from "./viewer-store";
import { Viewer } from "./viewer";
import { ContextMenu } from "./context-menu";
import { PromptDialog } from "./dialog";

export type GridSource =
  | { kind: "files"; pathPrefix?: string; tag?: string }
  | { kind: "search"; tokens: Token[] }
  | { kind: "ids"; ids: string[] };

export type Layout = "horizontal" | "vertical";
export type Grouping = "day" | "month" | "year";
export type TileSize = "small" | "medium" | "large";

const SIZE_SCALE: Record<TileSize, number> = { small: 0.6, medium: 1, large: 1.5 };

export function MediaGrid({
  source,
  selection,
  onSelectionChange,
  onContextMenu,
  onReorder,
  toolbar = true,
  sort: controlledSort,
  onSortChange,
  emptyState,
  header,
}: {
  source: GridSource;
  selection: Set<string>;
  onSelectionChange: (s: Set<string>) => void;
  onContextMenu?: (e: React.MouseEvent, fileId: string) => void;
  onReorder?: (ids: string[]) => void;
  toolbar?: boolean;
  sort?: Sort;
  onSortChange?: (s: Sort) => void;
  emptyState?: React.ReactNode;
  header?: React.ReactNode;
}) {
  const [internalSort, setInternalSort] = useState<Sort>("date");
  const sort = controlledSort ?? internalSort;
  const setSort = onSortChange ?? setInternalSort;
  const [grouping, setGrouping] = useState<Grouping>("day");
  const [layout, setLayout] = useState<Layout>("horizontal");
  const [size, setSize] = useState<TileSize>("medium");
  // include files from subfolders/subtags (default true; only relevant for
  // files sources with a pathPrefix or tag filter)
  const [includeKids, setIncludeKids] = useState(true);
  const settings = api.settings.get.useQuery();
  const utils = api.useUtils();
  const patchSettings = api.settings.patch.useMutation({
    onSuccess: () => void utils.settings.get.invalidate(),
  });
  const changeSize = (s: TileSize) => {
    setSize(s);
    patchSettings.mutate({ defaultThumbnailSize: s }); // persist so it survives reloads
  };
  useEffect(() => {
    if (settings.data?.defaultThumbnailSize) setSize(settings.data.defaultThumbnailSize);
  }, [settings.data?.defaultThumbnailSize]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // base row height from theme, scaled by tile size; re-read on theme change
  const [baseRowH, setBaseRowH] = useState(200);
  useEffect(() => {
    const read = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--row-h");
      setBaseRowH(Number.parseFloat(v) || 200);
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  const rowH = baseRowH * SIZE_SCALE[size];

  // ---------------- data
  const filesQ = api.files.list.useInfiniteQuery(
    {
      pathPrefix: source.kind === "files" ? source.pathPrefix : undefined,
      tag: source.kind === "files" ? source.tag : undefined,
      recursive: includeKids,
      sort,
    },
    {
      enabled: source.kind === "files",
      getNextPageParam: (p) => p.nextCursor ?? undefined,
    },
  );
  const searchQ = api.search.query.useInfiniteQuery(
    { tokens: source.kind === "search" ? source.tokens : [], sort },
    {
      enabled: source.kind === "search",
      getNextPageParam: (p) => p.nextCursor ?? undefined,
    },
  );
  const idsQ = api.files.list.useQuery(
    { ids: source.kind === "ids" ? source.ids : [] },
    { enabled: source.kind === "ids" },
  );

  const filesData = filesQ.data;
  const searchData = searchQ.data;
  const items: FileSummary[] = useMemo(() => {
    if (source.kind === "ids") return idsQ.data?.items ?? [];
    const q = source.kind === "files" ? filesData : searchData;
    return q?.pages.flatMap((p) => p.items) ?? [];
  }, [source.kind, idsQ.data, filesData, searchData]);

  const fetchNextPage = source.kind === "files" ? filesQ.fetchNextPage : searchQ.fetchNextPage;
  const hasNextPage = source.kind === "ids" ? false : (source.kind === "files" ? filesQ : searchQ).hasNextPage;

  useEffect(() => {
    publishViewerList({
      items,
      loadMore: hasNextPage ? () => void fetchNextPage() : null,
      hasMore: !!hasNextPage,
    });
  }, [items, hasNextPage, fetchNextPage]);

  // ---------------- layout math
  const gap = 4;
  const aspectOf = (f: FileSummary) => (f.width && f.height ? f.width / f.height : 1);

  const rows: GridRow[] = useMemo(() => {
    if (layout === "vertical") return [];
    return buildRows({
      items,
      width,
      rowH,
      gap,
      grouping,
      doGrouping: sort === "date" && source.kind !== "ids",
    });
  }, [items, layout, width, rowH, sort, grouping, source.kind]);

  // vertical: assign each item to the shortest column
  const colWidth = Math.round(rowH * 1.3);
  const colCount = Math.max(1, Math.floor((width - 36) / (colWidth + gap)));
  const columns = useMemo(() => {
    if (layout !== "vertical") return [];
    const heights = new Array<number>(colCount).fill(0);
    const cols: { file: FileSummary; top: number; height: number }[][] = Array.from({ length: colCount }, () => []);
    for (const f of items) {
      const c = heights.indexOf(Math.min(...heights));
      const h = colWidth / aspectOf(f);
      cols[c]!.push({ file: f, top: heights[c]!, height: h });
      heights[c]! += h + gap;
    }
    return cols;
  }, [items, layout, colCount, colWidth]);

  // ---------------- virtualization
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]!.type === "header" ? 46 : (rows[i] as { height: number }).height + 2 * PAD),
    overscan: 4,
  });

  const indexOf = useMemo(() => new Map(items.map((f, i) => [f.id, i])), [items]);

  // infinite scroll trigger (rows mode)
  useEffect(() => {
    const v = rowVirtualizer.getVirtualItems();
    const last = v[v.length - 1];
    if (last && last.index >= rows.length - 3 && hasNextPage) void fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowVirtualizer.getVirtualItems(), rows.length, hasNextPage]);

  // infinite scroll trigger (columns mode)
  useEffect(() => {
    if (layout !== "vertical") return;
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 800 && hasNextPage) void fetchNextPage();
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [layout, hasNextPage, fetchNextPage]);

  // ---------------- selection
  const anchor = useRef<number>(-1);
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectionChange(next);
    },
    [selection, onSelectionChange],
  );
  const toggleGroup = useCallback(
    (ids: string[]) => {
      const next = new Set(selection);
      if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      onSelectionChange(next);
    },
    [selection, onSelectionChange],
  );

  // click-drag range selection (ponytail: no rubber band, range replaces selection;
  // no auto-scroll — only rendered tiles can be entered). Mouse/pen drag freely;
  // touch long-presses first (to start selection) then drags to extend it via
  // elementFromPoint — touch pointerenter doesn't retarget during a scroll/drag.
  const dragFrom = useRef(-1);
  const dragged = useRef(false);
  const suppressClick = useRef(false);
  // long-press for touch: start a timer on pointerdown, cancel on move (>10px) or up.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef({ x: 0, y: 0 });
  // tracks the pointer type of the in-progress gesture so onClick (a MouseEvent) knows
  // whether it came from a touch tap; touch taps always open the viewer, long-press selects.
  const lastPointerType = useRef("mouse");
  // when true, the touch is in drag-select mode (long-press already fired) — pointermove
  // extends the selection to whatever tile is under the finger via elementFromPoint.
  const touchSelecting = useRef(false);
  useEffect(() => {
    const up = () => {
      if (dragged.current || touchSelecting.current) suppressClick.current = true;
      dragged.current = false;
      dragFrom.current = -1;
      touchSelecting.current = false;
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  // prevent the grid from scrolling while a touch drag-select is in progress — the finger
  // should sweep tiles into the selection, not pan the viewport. non-passive so preventDefault works.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevent = (e: TouchEvent) => {
      if (touchSelecting.current) e.preventDefault();
    };
    el.addEventListener("touchmove", prevent, { passive: false });
    return () => el.removeEventListener("touchmove", prevent);
  }, []);
  const selectRange = useCallback(
    (a: number, b: number, additive = false) => {
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
      const next = additive ? new Set(selection) : new Set<string>();
      for (let i = lo; i <= hi; i++) next.add(items[i]!.id);
      onSelectionChange(next);
    },
    [items, selection, onSelectionChange],
  );

  // selection bulk actions (⋮ menu)
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);
  const [tagPrompt, setTagPrompt] = useState<"add" | "remove" | null>(null);
  const setTags = api.tags.setTags.useMutation({ onSuccess: () => void utils.tags.invalidate() });

  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const viewerId = params.get("v");

  // Esc clears the selection (skipped while viewer/menu/dialog is open — those consume Esc)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || selection.size === 0 || viewerId || selMenu || tagPrompt) return;
      onSelectionChange(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection.size, viewerId, selMenu, tagPrompt, onSelectionChange]);

  const openViewer = (id: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("v", id);
    router.push(`${pathname}?${p.toString()}`);
  };
  const closeViewer = () => {
    const p = new URLSearchParams(params.toString());
    p.delete("v");
    router.push(p.size ? `${pathname}?${p.toString()}` : pathname);
  };

  const onTileClick = (e: React.MouseEvent, f: FileSummary, index: number) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    // touch: tap always opens the viewer — selection is via long-press, not tap.
    // (a long-press sets suppressClick, so we never reach here after one.)
    if (lastPointerType.current === "touch") {
      anchor.current = index;
      openViewer(f.id);
      return;
    }
    if (e.shiftKey && anchor.current >= 0) {
      selectRange(anchor.current, index, true);
    } else if (e.ctrlKey || e.metaKey || selection.size > 0) {
      // any plain click toggles while a selection exists — viewer opens only
      // when nothing is selected
      anchor.current = index;
      toggle(f.id);
    } else {
      anchor.current = index;
      openViewer(f.id);
    }
  };

  // ---------------- dnd reorder (queue)
  const dragId = useRef<string | null>(null);
  const drop = (targetId: string) => {
    const src = dragId.current;
    dragId.current = null;
    if (!src || !onReorder || src === targetId) return;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(src);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    onReorder(ids);
  };

  const renderTile = (f: FileSummary) => {
    const index = indexOf.get(f.id) ?? -1;
    return (
      <div
        key={f.id}
        data-file-id={f.id}
        className={`tile ${f.mediaType === "video" ? "vid" : ""} ${selection.has(f.id) ? "sel" : ""}`}
        draggable={!!onReorder}
        onDragStart={() => (dragId.current = f.id)}
        onDragOver={(e) => onReorder && e.preventDefault()}
        onDrop={() => drop(f.id)}
        onClick={(e) => onTileClick(e, f, index)}
        onContextMenu={(e) => onContextMenu && (e.preventDefault(), onContextMenu(e, f.id))}
        onPointerDown={(e) => {
          suppressClick.current = false;
          lastPointerType.current = e.pointerType;
          if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            if (e.pointerType === "touch") {
              // long-press → toggle into selection, then enter drag-select mode so the
              // finger can sweep more tiles; cancelled by pointerup/move(>10px) below.
              longPressStart.current = { x: e.clientX, y: e.clientY };
              longPressTimer.current = setTimeout(() => {
                anchor.current = index;
                dragFrom.current = index;
                touchSelecting.current = true;
                suppressClick.current = true;
                if (navigator.vibrate) navigator.vibrate(15);
                longPressTimer.current = null;
                // ponytail: toggle (not replace) so a long-press on an already-selected
                // tile removes it; the subsequent drag extends from dragFrom.
                toggle(f.id);
              }, 500);
            } else {
              dragFrom.current = index;
            }
          }
        }}
        onPointerMove={(e) => {
          if (longPressTimer.current) {
            // a touch that moves >10px before the long-press fires is a scroll — cancel
            if (Math.abs(e.clientX - longPressStart.current.x) > 10 || Math.abs(e.clientY - longPressStart.current.y) > 10) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
            }
          }
          if (touchSelecting.current && e.pointerType === "touch") {
            // sweep-select: find the tile under the finger and extend the range to it
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const tile = el?.closest("[data-file-id]") as HTMLElement | null;
            const tid = tile?.dataset.fileId;
            if (tid) {
              const ti = indexOf.get(tid);
              if (ti !== undefined && ti !== dragFrom.current) selectRange(dragFrom.current, ti);
            }
          }
        }}
        onPointerUp={() => {
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
        }}
        onPointerEnter={(e) => {
          // mouse/pen drag-select; touch scroll fires pointerenter too but dragFrom
          // stays -1 on touch (long-press branch), so this never fires for touch
          if (dragFrom.current >= 0 && (e.buttons & 1) === 1 && dragFrom.current !== index && e.pointerType !== "touch") {
            selectRange(dragFrom.current, index);
            dragged.current = true;
          }
        }}
      >
        <ThumbImg id={f.id} />
        <div className="ovl" />
        <div
          className="check"
          onClick={(e) => {
            e.stopPropagation();
            anchor.current = index;
            toggle(f.id);
          }}
        >
          {selection.has(f.id) ? "✓" : ""}
        </div>
        {f.mediaType === "video" && (
          <div className="badge">{formatDuration(f.duration)}</div>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar && (
        <div className="flex flex-wrap flex-none items-center gap-2 px-4 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="seg hidden sm:flex">
            {(["horizontal", "vertical"] as const).map((l) => (
              <button key={l} className={layout === l ? "on" : ""} onClick={() => setLayout(l)}>
                {l === "horizontal" ? "Rows" : "Columns"}
              </button>
            ))}
          </div>
          {source.kind !== "ids" && (
            <>
              <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="date">Date</option>
                <option value="similarity">Similarity</option>
                <option value="name">Name</option>
                <option value="size">Size</option>
                <option value="random">Random</option>
              </select>
              {sort === "date" && (
                <select className="input" value={grouping} onChange={(e) => setGrouping(e.target.value as Grouping)}>
                  <option value="day">Day</option>
                  <option value="month">Month</option>
                  <option value="year">Year</option>
                </select>
              )}
            </>
          )}
          {source.kind === "files" && (source.pathPrefix ?? source.tag) && (
            <label className="flex items-center gap-1 text-xs" style={{ color: "var(--text-dim)" }} title="Include files from subfolders/subtags">
              <input
                type="checkbox"
                checked={includeKids}
                onChange={(e) => setIncludeKids(e.target.checked)}
              />
              {source.pathPrefix ? "Subfolders" : "Subtags"}
            </label>
          )}
          <div className="ml-auto flex items-center gap-2">
            {selection.size > 0 && (
              <>
                <span className="text-xs" style={{ color: "var(--text-faint)" }}>{selection.size} selected</span>
                <button
                  className="btn"
                  style={{ padding: "3px 10px", fontSize: 12 }}
                  onClick={() => onSelectionChange(new Set(items.map((f) => f.id)))}
                >
                  Select all
                </button>
                <button
                  className="btn"
                  style={{ padding: "3px 8px", fontSize: 12 }}
                  title="Clear selection"
                  onClick={() => onSelectionChange(new Set())}
                >
                  ✕
                </button>
                <button
                  className="btn"
                  style={{ padding: "3px 8px", fontSize: 12 }}
                  title="Selection actions"
                  onClick={(e) => setSelMenu({ x: e.clientX, y: e.clientY + 8 })}
                >
                  ⋮
                </button>
              </>
            )}
            <div className="seg">
              {(["small", "medium", "large"] as const).map((s) => (
                <button key={s} className={size === s ? "on" : ""} onClick={() => changeSize(s)}>
                  {s[0]!.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div ref={scrollRef} className="scroll-thin flex-1 select-none overflow-y-auto px-4 pb-10" style={{ touchAction: "pan-y" }}>
        {header}
        {items.length === 0 && (filesQ.isLoading || searchQ.isLoading || idsQ.isLoading) && (
          <p className="p-8 text-sm" style={{ color: "var(--text-faint)" }}>Loading…</p>
        )}
        {items.length === 0 && !(filesQ.isLoading || searchQ.isLoading || idsQ.isLoading) && (
          <div className="p-8 text-sm" style={{ color: "var(--text-faint)" }}>{emptyState ?? "Nothing here yet."}</div>
        )}
        {layout === "horizontal" && rows.length > 0 && (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const row = rows[vr.index]!;
              return (
                <div
                  key={vr.key}
                  data-index={vr.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vr.start}px)`,
                    padding: row.type === "tiles" ? `${PAD}px 0` : undefined,
                  }}
                >
                  {row.type === "header" ? (
                    <div className="ghead" style={{ gap: PACK_GAP }}>
                      {row.segs.map((s, i) => (
                        <div key={i} className="gseg" style={s.width ? { width: s.width, flex: "none" } : undefined}>
                          <button
                            className={`gh-check ${s.ids.every((id) => selection.has(id)) ? "on" : ""}`}
                            title="Select group"
                            onClick={() => toggleGroup(s.ids)}
                          >
                            {s.ids.every((id) => selection.has(id)) ? "✓" : ""}
                          </button>
                          <div className="gseg-label">{s.label}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex" style={{ gap: row.groupSizes ? PACK_GAP : gap, height: row.height }}>
                      {chunkGroups(row.files, row.groupSizes).map((gf, gi) => (
                        <div key={gi} className="flex" style={{ gap }}>
                          {gf.map((f) => (
                            <div key={f.id} style={{ width: row.height * aspectOf(f) + 2 * PAD, padding: `0 ${PAD}px`, flex: "none" }}>
                              {renderTileSized(f)}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {layout === "vertical" && (
          <div className="flex" style={{ gap }}>
            {columns.map((col, ci) => (
              <ColumnView key={ci} col={col} width={colWidth} gap={gap} scrollRef={scrollRef} renderTileSized={renderTileSized} />
            ))}
          </div>
        )}
      </div>
      {viewerId && <Viewer fileId={viewerId} onClose={closeViewer} />}
      {selMenu && (
        <ContextMenu
          x={selMenu.x}
          y={selMenu.y}
          onClose={() => setSelMenu(null)}
          items={[
            { label: "Add tag…", onClick: () => setTagPrompt("add") },
            { label: "Remove tag…", onClick: () => setTagPrompt("remove") },
          ]}
        />
      )}
      {tagPrompt && (
        <PromptDialog
          title={tagPrompt === "add" ? "Add tag" : "Remove tag"}
          label={`Tag to ${tagPrompt} on ${selection.size} file${selection.size === 1 ? "" : "s"}`}
          onSubmit={(tag) =>
            setTags.mutate({
              fileIds: [...selection],
              add: tagPrompt === "add" ? [tag] : [],
              remove: tagPrompt === "remove" ? [tag] : [],
            })
          }
          onClose={() => setTagPrompt(null)}
        />
      )}
    </div>
  );

  function renderTileSized(f: FileSummary) {
    return (
      <div style={{ width: "100%", height: "100%" }}>{renderTile(f)}</div>
    );
  }
}

function ColumnView({
  col,
  width,
  gap,
  scrollRef,
  renderTileSized,
}: {
  col: { file: FileSummary; top: number; height: number }[];
  width: number;
  gap: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  renderTileSized: (f: FileSummary) => React.ReactNode;
}) {
  const total = col.reduce((m, c) => Math.max(m, c.top + c.height), 0);
  const v = useVirtualizer({
    count: col.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => col[i]!.height + gap,
    overscan: 6,
  });
  return (
    <div style={{ width, flex: "none", height: total, position: "relative" }}>
      {v.getVirtualItems().map((vi) => {
        const c = col[vi.index]!;
        return (
          <div key={c.file.id} style={{ position: "absolute", top: c.top, left: 0, width, height: c.height, padding: PAD }}>
            {renderTileSized(c.file)}
          </div>
        );
      })}
    </div>
  );
}

/** Thumb with placeholder + retry while the thumbnail is still being generated. */
function ThumbImg({ id }: { id: string }) {
  const [retry, setRetry] = useState(0);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    // ponytail: fixed 2s poll, capped at ~1 min (files that can never thumb just stay blank)
    if (!missing || retry >= 30) return;
    const t = setTimeout(() => {
      setMissing(false);
      setRetry((r) => r + 1);
    }, 2000);
    return () => clearTimeout(t);
  }, [missing, retry]);
  if (missing) return <div className="thumb-wait" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/thumb/${id}${retry > 0 ? `?r=${retry}` : ""}`}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setMissing(true)}
    />
  );
}

/** Split a tiles row back into per-group chunks (packed rows keep group gaps). */
function chunkGroups(files: FileSummary[], sizes?: number[]): FileSummary[][] {
  if (!sizes) return [files];
  const out: FileSummary[][] = [];
  let i = 0;
  for (const s of sizes) {
    out.push(files.slice(i, i + s));
    i += s;
  }
  return out;
}

export function formatDuration(d: number | null): string {
  if (!d) return "0:00";
  const m = Math.floor(d / 60);
  const s = Math.floor(d % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
