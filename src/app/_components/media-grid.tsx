"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import type { FileSummary, Sort, Token } from "refr/server/services/search";
import { isVectorToken } from "refr/server/services/search";
import type { TimelineBucket } from "refr/lib/timeline";
import { buildTimelineLayout, timelineOffset, timelinePosition, timelineRowHeight, type TimelineLayout, type TimelineRow } from "refr/lib/timeline-layout";
import { buildRows, tileWidth, SIZE_SCALE, PACK_GAP, PAD, type GridRow } from "refr/lib/grid-rows";
import { publishViewerList } from "./viewer-store";
import { Viewer } from "./viewer";
import { ContextMenu } from "./context-menu";
import { TagPromptDialog } from "./dialog";
import { TimelineScrubber } from "./timeline-scrubber";
import { staticSuggestionOptions, useTagEdit } from "./tag-actions";
import { Icon } from "./icon";
import { useActionFeedback } from "./action-feedback";

export type GridSource =
  | { kind: "files"; pathPrefix?: string; tag?: string }
  | { kind: "search"; tokens: Token[] }
  | { kind: "ids"; ids: string[] };

export type Layout = "horizontal" | "vertical";
export type Grouping = "day" | "month" | "year";
export type TileSize = "small" | "medium" | "large";

export function MediaGrid({
  source,
  selection,
  onSelectionChange,
  onContextMenu,
  onReorder,
  toolbar = true,
  toolbarActions,
  toolbarSearch,
  sort: controlledSort,
  onSortChange,
  emptyState,
  header,
  hiddenIds,
  tileActions,
}: {
  source: GridSource;
  selection: Set<string>;
  onSelectionChange: (s: Set<string>) => void;
  onContextMenu?: (e: React.MouseEvent, fileId: string) => void;
  onReorder?: (ids: string[]) => void;
  toolbar?: boolean;
  toolbarActions?: React.ReactNode;
  toolbarSearch?: React.ReactNode;
  sort?: Sort;
  onSortChange?: (s: Sort) => void;
  emptyState?: React.ReactNode;
  header?: React.ReactNode;
  /** Remove reviewed tiles and wrap survivors at the same fixed row height. */
  hiddenIds?: ReadonlySet<string>;
  /** per-tile overlay (replaces the selection checkbox, like the browse suggestion strips) */
  tileActions?: (f: FileSummary) => React.ReactNode;
}) {
  const [internalSort, setInternalSort] = useState<Sort>("date");
  const vectorMode = source.kind === "search" && source.tokens.some(isVectorToken);
  const suggestionMode = source.kind === "search" && source.tokens.some((token) => token.kind === "tag" && token.tag.startsWith("suggest:"));
  const sort = vectorMode ? "similarity" : controlledSort ?? internalSort;
  const setSort = onSortChange ?? setInternalSort;
  const [grouping, setGrouping] = useState<Grouping>("day");
  const [layout, setLayout] = useState<Layout>("horizontal");
  const [size, setSize] = useState<TileSize>("medium");
  // include files from subfolders/subtags (default true; only relevant for
  // files sources with a pathPrefix or tag filter)
  const [includeKids, setIncludeKids] = useState(true);
  const settings = api.settings.get.useQuery();
  const utils = api.useUtils();
  const notify = useActionFeedback();
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
  const headerRef = useRef<HTMLDivElement>(null);
  const scrollId = useId();
  const [width, setWidth] = useState(1200);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const latestScrollTop = useRef(0);
  const updateScrollTop = useCallback((top: number) => {
    latestScrollTop.current = top;
    setScrollTop(top);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => { setWidth(el.clientWidth); setViewportHeight(el.clientHeight); };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const read = () => setHeaderHeight(el.clientHeight);
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
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
  const filterKey = JSON.stringify({
    k: source.kind,
    p: source.kind === "files" ? source.pathPrefix : undefined,
    t: source.kind === "files" ? source.tag : undefined,
    s: source.kind === "search" ? source.tokens : undefined,
    kids: includeKids,
    sort,
  });
  // month buckets for the whole filtered library (timeline scrubber)
  const timelineQ = api.files.timeline.useQuery(
    {
      pathPrefix: source.kind === "files" ? source.pathPrefix : undefined,
      tag: source.kind === "files" ? source.tag : undefined,
      recursive: includeKids,
    },
    { enabled: source.kind === "files" && sort === "date" },
  );
  const searchTimelineQ = api.search.timeline.useQuery(
    { tokens: source.kind === "search" ? source.tokens : [] },
    { enabled: source.kind === "search" && sort === "date" && !suggestionMode && !vectorMode },
  );
  const buckets =
    source.kind === "files"
      ? timelineQ.data
      : source.kind === "search"
        ? searchTimelineQ.data
        : undefined;
  const timelineMode = sort === "date" && layout === "horizontal" && !suggestionMode && !vectorMode && (buckets?.length ?? 0) > 0;
  const showTimeline = timelineMode;
  const [visibleMonths, setVisibleMonths] = useState({ key: "", indices: [0] });
  const filesQ = api.files.list.useInfiniteQuery(
    {
      pathPrefix: source.kind === "files" ? source.pathPrefix : undefined,
      tag: source.kind === "files" ? source.tag : undefined,
      recursive: includeKids,
      sort,
    },
    {
      enabled: source.kind === "files" && !timelineMode,
      getNextPageParam: (p) => p.nextCursor ?? undefined,
    },
  );
  const searchQ = api.search.query.useInfiniteQuery(
    { tokens: source.kind === "search" ? source.tokens : [], sort },
    {
      ...(suggestionMode ? staticSuggestionOptions : {}),
      enabled: source.kind === "search" && !timelineMode,
      getNextPageParam: (p) => p.nextCursor ?? undefined,
    },
  );
  const idsQ = api.files.list.useQuery(
    { ids: source.kind === "ids" ? source.ids : [] },
    { enabled: source.kind === "ids" },
  );

  const filesData = filesQ.data;
  const searchData = searchQ.data;
  const firstPageQuery = source.kind === "files" ? filesQ : searchQ;
  const firstPageItems = firstPageQuery.data?.pages[0]?.items;
  const waitingForFirstPage = !firstPageQuery.data && firstPageQuery.isFetching;
  const previewMonths = useMemo(() => (buckets ?? []).map((b) => {
    // Use the server's timestamp range, not the browser's possibly different timezone.
    const items = firstPageItems?.filter((f) => f.mtime >= b.minMtime && f.mtime <= b.maxMtime);
    return items?.length ? { items, nextCursor: null, prevCursor: null } : undefined;
  }), [buckets, firstPageItems]);
  // Let an in-flight first page seed complete months before creating their queries.
  const monthQueries = api.useQueries((t) => timelineMode && !waitingForFirstPage ? (buckets ?? []).map((b, i) => {
    const preview = previewMonths[i];
    const options = {
      enabled: (visibleMonths.key === filterKey ? visibleMonths.indices : [0]).includes(i),
      staleTime: 60_000,
      // A month already covered by the first page needs no second request.
      initialData: preview?.items.length === b.count ? preview : undefined,
      initialDataUpdatedAt: firstPageQuery.dataUpdatedAt,
    };
    const month = { year: b.year, month: b.month };
    return source.kind === "files"
      ? t.files.list({ pathPrefix: source.pathPrefix, tag: source.tag, recursive: includeKids, month }, options)
      : t.search.query({ tokens: source.kind === "search" ? source.tokens : [], month }, options);
  }) : [], {
    // Start thumbnail requests from the first page while dense months load.
    combine: (results) => results.map((q, i) => ({
      items: q.data?.items ?? previewMonths[i]?.items,
      partial: !q.data && !!previewMonths[i] && previewMonths[i].items.length < buckets![i]!.count,
      error: q.error,
      refetch: q.refetch,
    })),
  });
  const items: FileSummary[] = useMemo(() => {
    return (
      timelineMode ? monthQueries.flatMap((q) => q.items ?? []) : source.kind === "ids"
        ? (idsQ.data?.items ?? [])
        : ((source.kind === "files" ? filesData : searchData)?.pages.flatMap((p) => p.items) ?? [])
    );
  }, [timelineMode, monthQueries, source.kind, idsQ.data, filesData, searchData]);
  const visibleItems = useMemo(() => hiddenIds?.size ? items.filter((f) => !hiddenIds.has(f.id)) : items, [items, hiddenIds]);

  const fetchNextPage = source.kind === "files" ? filesQ.fetchNextPage : searchQ.fetchNextPage;
  const hasNextPage = source.kind === "ids" || timelineMode ? false : (source.kind === "files" ? filesQ : searchQ).hasNextPage;
  const activeQuery = source.kind === "ids" ? idsQ : source.kind === "files" ? filesQ : searchQ;
  const firstSearchPage = searchData?.pages[0];
  const searchNotice = source.kind === "search" && firstSearchPage && "notice" in firstSearchPage && typeof firstSearchPage.notice === "string" ? firstSearchPage.notice : undefined;
  useEffect(() => {
    if (source.kind !== "search" || !searchData?.pages.some((page) => "restart" in page && page.restart)) return;
    void utils.search.query.reset({ tokens: source.tokens, sort });
    scrollRef.current?.scrollTo({ top: 0 });
  }, [searchData, source, sort, utils]);

  // ---------------- layout math
  const gap = 4;
  const aspectOf = (f: FileSummary) => (f.width && f.height ? f.width / f.height : 1);

  const timelineLayout = useMemo(() => buildTimelineLayout({
    buckets: timelineMode ? buckets ?? [] : [],
    months: monthQueries.map((q) => hiddenIds?.size ? q.items?.filter((f) => !hiddenIds.has(f.id)) : q.items),
    partialMonths: monthQueries.map((q) => q.partial),
    width, rowH, gap, grouping,
  }), [timelineMode, buckets, monthQueries, hiddenIds, width, rowH, grouping]);
  // Keep the track fixed while months load, as Immich does. Actual canvas
  // geometry changes underneath it, but a pointer coordinate keeps its date.
  const scrubberHeights = useMemo(() => buildTimelineLayout({
    buckets: buckets ?? [], months: [], width, rowH, gap, grouping,
  }).positions.map((p) => p.height), [buckets, width, rowH, grouping]);
  const rows: (GridRow | TimelineRow)[] = useMemo(() => {
    if (layout === "vertical") return [];
    if (timelineMode) return timelineLayout.rows;
    return buildRows({
      items: visibleItems,
      width,
      rowH,
      gap,
      grouping,
      doGrouping: sort === "date" && source.kind !== "ids",
    });
  }, [visibleItems, layout, timelineMode, timelineLayout, width, rowH, sort, grouping, source.kind]);

  // vertical: assign each item to the shortest column
  const colWidth = Math.round(rowH * 1.3);
  const colCount = Math.max(1, Math.floor((width - 36) / (colWidth + gap)));
  const columns = useMemo(() => {
    if (layout !== "vertical") return [];
    const heights = new Array<number>(colCount).fill(0);
    const cols: { file: FileSummary; top: number; height: number }[][] = Array.from({ length: colCount }, () => []);
    for (const f of visibleItems) {
      const c = heights.indexOf(Math.min(...heights));
      const h = colWidth / aspectOf(f);
      cols[c]!.push({ file: f, top: heights[c]!, height: h });
      heights[c]! += h + gap;
    }
    return cols;
  }, [visibleItems, layout, colCount, colWidth]);

  // ---------------- virtualization
  // Stable per-content keys so prepended rows keep their measured sizes instead
  // of inheriting the old row-at-this-index (which makes the grid jump).
  const rowKey = useCallback(
    (i: number) => {
      const r = rows[i];
      if (!r) return `row-${i}`;
      if (r.type === "placeholder") return `month:${r.monthIndex}`;
      return r.type === "header"
        ? `h:${r.segs.flatMap((s) => s.ids).slice(0, 4).join(",")}`
        : `t:${r.files[0]?.id ?? i}`;
    },
    [rows],
  );
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: rowKey,
    estimateSize: (i) => timelineMode ? timelineRowHeight(rows[i]!, gap) : (rows[i]!.type === "header" ? 46 : (rows[i] as { height: number }).height + 2 * PAD + gap),
    scrollMargin: headerHeight,
    overscan: 4,
  });
  useLayoutEffect(() => {
    if (timelineMode) rowVirtualizer.measure();
  }, [timelineMode, rowH, rowVirtualizer]);

  const indexOf = useMemo(() => new Map(items.map((f, i) => [f.id, i])), [items]);

  // Like Immich, map the full timeline onto the *scrollable* range. This makes
  // the last month reachable even when it is shorter than the viewport.
  const scrollScale = timelineLayout.height > 0
    ? Math.max(0, timelineLayout.height + headerHeight + 40 - viewportHeight) / timelineLayout.height
    : 0;
  const activeMonth = timelineMode
    ? timelinePosition(timelineLayout, scrollScale > 0 ? scrollTop / scrollScale : 0)
    : null;
  const seekToBucket = (bucket: TimelineBucket, fraction: number) => {
    scrollRef.current?.scrollTo({ top: timelineOffset(timelineLayout, { ...bucket, fraction }) * scrollScale, behavior: "instant" });
    updateScrollTop(scrollRef.current?.scrollTop ?? 0);
  };

  // Loading/resize changes geometry, not the month/fraction the user chose.
  const previousTimeline = useRef<{ key: string; layout: TimelineLayout; scale: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const previous = previousTimeline.current;
    if (!timelineMode || !el) {
      previousTimeline.current = null;
      return;
    }
    const position = previous?.key === filterKey
      ? timelinePosition(previous.layout, previous.scale > 0 ? latestScrollTop.current / previous.scale : 0)
      : null;
    el.scrollTop = position ? timelineOffset(timelineLayout, position) * scrollScale : 0;
    updateScrollTop(el.scrollTop);
    previousTimeline.current = { key: filterKey, layout: timelineLayout, scale: scrollScale };
  }, [timelineMode, filterKey, timelineLayout, scrollScale, updateScrollTop]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (!timelineMode) return;
    const top = scrollTop;
    const indices = new Set<number>();
    for (const vr of virtualRows) {
      if (vr.end < top || vr.start > top + viewportHeight) continue;
      const index = (rows[vr.index] as TimelineRow).monthIndex;
      for (const i of [index - 1, index, index + 1]) {
        if (i >= 0 && i < timelineLayout.positions.length) indices.add(i);
      }
    }
    const next = [...indices].sort((a, b) => a - b);
    setVisibleMonths((prev) => prev.key === filterKey && prev.indices.join() === next.join()
      ? prev : { key: filterKey, indices: next });
  }, [timelineMode, virtualRows, rows, viewportHeight, timelineLayout.positions.length, filterKey, scrollTop]);

  // infinite scroll trigger (rows mode)
  useEffect(() => {
    const v = rowVirtualizer.getVirtualItems();
    const last = v[v.length - 1];
    const atEnd = last ? last.index >= rows.length - 3 : items.length > 0 && visibleItems.length === 0;
    if (layout === "horizontal" && atEnd && hasNextPage && !activeQuery.isFetching) void fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowVirtualizer.getVirtualItems(), rows.length, items.length, visibleItems.length, layout, hasNextPage, activeQuery.isFetching]);

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
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAllAbort = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    setSelectingAll(false);
    return () => selectAllAbort.current?.abort();
  }, [filterKey, selection]);
  const selectAll = async () => {
    if (source.kind !== "files") {
      onSelectionChange(new Set(visibleItems.map((f) => f.id)));
      return;
    }
    if (selectAllAbort.current && !selectAllAbort.current.signal.aborted) return;
    const controller = new AbortController();
    selectAllAbort.current = controller;
    setSelectingAll(true);
    try {
      // ponytail: keep explicit IDs for existing bulk actions; use filter-based
      // selections if the complete ID set becomes too large for the browser.
      const selected = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await utils.client.files.ids.query({
          pathPrefix: source.pathPrefix, tag: source.tag, recursive: includeKids, cursor,
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        for (const id of page.ids) if (!hiddenIds?.has(id)) selected.add(id);
        cursor = page.nextCursor;
      } while (cursor);
      onSelectionChange(selected);
    } catch (error) {
      if (!controller.signal.aborted) notify({ message: error instanceof Error ? error.message : "Could not select all images. Please try again.", error: true });
    } finally {
      if (selectAllAbort.current === controller) {
        selectAllAbort.current = null;
        if (!controller.signal.aborted) setSelectingAll(false);
      }
    }
  };
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
  // Also: touchmove keeps firing during a browser-pan (unlike pointermove, which stops once
  // touch-action:pan-y hands off), so we cancel any pending long-press here when the finger
  // moves >10px — that's the scroll signal.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (touchSelecting.current) {
        e.preventDefault();
      } else if (longPressTimer.current) {
        const t = e.touches[0];
        if (t && (Math.abs(t.clientX - longPressStart.current.x) > 10 || Math.abs(t.clientY - longPressStart.current.y) > 10)) {
          clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
      }
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, []);
  const selectRange = useCallback(
    (a: number, b: number, additive = false) => {
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
      const next = additive ? new Set(selection) : new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const id = items[i]!.id;
        if (!hiddenIds?.has(id)) next.add(id);
      }
      onSelectionChange(next);
    },
    [items, hiddenIds, selection, onSelectionChange],
  );

  // selection bulk actions (⋮ menu)
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);
  const [tagPrompt, setTagPrompt] = useState<"add" | "remove" | null>(null);
  const setTags = useTagEdit();

  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const viewerId = params.get("v");

  // The viewer must not skip unloaded months between separately visited dates.
  const viewerRange = useMemo(() => {
    if (!timelineMode) return { items: visibleItems, next: null };
    const viewerMonth = monthQueries.findIndex((q) => q.items?.some((f) => f.id === viewerId));
    let start = viewerMonth >= 0 ? viewerMonth : (buckets?.findIndex((b) => b.year === activeMonth?.year && b.month === activeMonth.month) ?? 0);
    let end = start;
    while (start > 0 && monthQueries[start - 1]?.items && !monthQueries[start - 1]?.partial) start--;
    while (end + 1 < monthQueries.length && !monthQueries[end]?.partial && monthQueries[end + 1]?.items) end++;
    return {
      items: monthQueries.slice(start, end + 1).flatMap((q) => q.items ?? []).filter((f) => !hiddenIds?.has(f.id)),
      next: (monthQueries[end]?.partial ? monthQueries[end] : monthQueries[end + 1]) ?? null,
    };
  }, [timelineMode, visibleItems, monthQueries, viewerId, buckets, activeMonth?.year, activeMonth?.month, hiddenIds]);
  useEffect(() => {
    publishViewerList({
      items: viewerRange.items,
      loadMore: timelineMode ? viewerRange.next ? () => void viewerRange.next?.refetch() : null : hasNextPage ? () => void fetchNextPage() : null,
      hasMore: timelineMode ? !!viewerRange.next : !!hasNextPage,
    });
  }, [viewerRange, timelineMode, hasNextPage, fetchNextPage]);

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
    if (e.detail !== 0 && lastPointerType.current === "touch") {
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
        onContextMenu={(e) => onContextMenu && (e.preventDefault(), onContextMenu(e, f.id))}
        onPointerDown={(e) => {
          if (!(e.target as HTMLElement).closest(".tile-open")) return;
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
              if (ti !== undefined && ti !== dragFrom.current) selectRange(dragFrom.current, ti, true);
            }
          }
        }}
        onPointerUp={() => {
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
        }}
        onPointerCancel={() => {
          // browser took over the gesture (touch-action: pan-y scroll) — cancel the
          // long-press so scrolling never selects a tile
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
        }}
        onPointerEnter={(e) => {
          // mouse/pen drag-select; touch scroll fires pointerenter too but dragFrom
          // stays -1 on touch (long-press branch), so this never fires for touch
          if (dragFrom.current >= 0 && (e.buttons & 1) === 1 && dragFrom.current !== index && e.pointerType !== "touch") {
            // additive: dragging extends the selection, never de-selects tiles picked earlier
            selectRange(dragFrom.current, index, true);
            dragged.current = true;
          }
        }}
      >
        <button
          type="button"
          className="tile-open"
          aria-label={`Open ${f.mediaType} ${index + 1}`}
          onClick={(e) => onTileClick(e, f, index)}
        >
          <ThumbImg id={f.id} />
          <span className="ovl" />
        </button>
        {tileActions ? (
          tileActions(f)
        ) : (
          <button
            type="button"
            className="check"
            aria-label={`Select ${f.mediaType} ${index + 1}`}
            aria-pressed={selection.has(f.id)}
            onClick={(e) => {
              e.stopPropagation();
              anchor.current = index;
              toggle(f.id);
            }}
          >
            {selection.has(f.id) ? <Icon name="check" /> : null}
          </button>
        )}
        {onContextMenu && (
          <button
            type="button"
            className="tile-menu"
            aria-label={`Actions for ${f.mediaType} ${index + 1}`}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onContextMenu({ ...e, clientX: r.left, clientY: r.bottom }, f.id);
            }}
          ><Icon name="more" /></button>
        )}
        {f.mediaType === "video" && (
          <div className="badge">{formatDuration(f.duration)}</div>
        )}
      </div>
    );
  };

  const viewControls = (
    <div className="gallery-view-controls">
      {suggestionMode && <button className="btn" disabled={searchQ.isFetching} onClick={() => void searchQ.refetch()}>Refresh suggestions</button>}
      <div className="seg">
        {(["horizontal", "vertical"] as const).map((l) => (
          <button key={l} className={layout === l ? "on" : ""} aria-pressed={layout === l} onClick={() => setLayout(l)}>
            {l === "horizontal" ? "Rows" : "Columns"}
          </button>
        ))}
      </div>
      {source.kind !== "ids" && (
        <>
          <select aria-label="Sort images" title={vectorMode ? "Semantic searches are ranked by similarity" : undefined} disabled={vectorMode} className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="date">Date</option>
            <option value="similarity">Similarity</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="random">Random</option>
          </select>
          {sort === "date" && (
            <select aria-label="Group images" className="input" value={grouping} onChange={(e) => setGrouping(e.target.value as Grouping)}>
              <option value="day">Day</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          )}
        </>
      )}
      {toolbarActions}
      {source.kind === "files" && (source.pathPrefix ?? source.tag) && (
        <label className="flex items-center gap-1 text-xs" style={{ color: "var(--text-dim)" }} title="Include files from subfolders/subtags">
          <input type="checkbox" checked={includeKids} onChange={(e) => setIncludeKids(e.target.checked)} />
          {source.pathPrefix ? "Subfolders" : "Subtags"}
        </label>
      )}
    </div>
  );
  const selectionControls = (
    <div className="gallery-toolbar-end">
      {selection.size > 0 && (
        <>
          <span className="text-xs" style={{ color: "var(--text-faint)" }}>{selection.size} selected</span>
          <button className="btn" disabled={selectingAll} aria-busy={selectingAll} onClick={selectAll}>{selectingAll ? "Selecting…" : "Select all"}</button>
          <button className="btn" title="Clear selection" aria-label="Clear selection" onClick={() => onSelectionChange(new Set())}>
            <Icon name="close" />
          </button>
          <button className="btn" disabled={selectingAll} title="Selection actions" aria-label="Selection actions" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setSelMenu({ x: rect.left, y: rect.bottom + 8 });
          }}>
            <Icon name="more" />
          </button>
        </>
      )}
      <div className="seg">
        {(["small", "medium", "large"] as const).map((s) => (
          <button key={s} className={size === s ? "on" : ""} aria-label={`${s} thumbnails`} aria-pressed={size === s} onClick={() => changeSize(s)}>
            {s[0]!.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar && (
        <div className="gallery-toolbar">
          {toolbarSearch ? <><div className="gallery-search">{toolbarSearch}</div>{selectionControls}{viewControls}</> : <>{viewControls}{selectionControls}</>}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div id={scrollId} ref={scrollRef} onScroll={(e) => updateScrollTop(e.currentTarget.scrollTop)} className="scroll-thin min-w-0 flex-1 select-none overflow-y-auto px-4 pb-10" style={{ touchAction: "pan-y", overflowAnchor: "none" }}>
        <div ref={headerRef}>
          {header}
          {searchNotice && <p role="status" className="state-message">{searchNotice}</p>}
        </div>
        {!timelineMode && activeQuery.isError && (
          <div role="alert" className="state-message">
            <p>Could not load images. {activeQuery.error.message}</p>
            <button className="btn mt-2" onClick={() => void activeQuery.refetch()}>Try again</button>
          </div>
        )}
        {!timelineMode && items.length === 0 && activeQuery.isLoading && (
          <p role="status" className="state-message">Loading images…</p>
        )}
        {!timelineMode && items.length === 0 && !activeQuery.isLoading && !activeQuery.isError && (
          <div className="state-message">{emptyState ?? "Nothing here yet."}</div>
        )}
        {layout === "horizontal" && rows.length > 0 && (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const row = rows[vr.index]!;
              return (
                <div
                  key={vr.key}
                  data-index={vr.index}
                  ref={timelineMode ? undefined : rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vr.start - headerHeight}px)`,
                    height: timelineMode ? vr.size : undefined,
                    padding: row.type === "tiles" ? `${PAD}px 0 ${PAD + gap}px` : undefined,
                  }}
                >
                  {row.type === "placeholder" ? (
                    <div className="tl-placeholder" style={{ height: row.height }} role={monthQueries[row.monthIndex]?.error ? "alert" : "status"}>
                      <div className="state-message">
                        {monthQueries[row.monthIndex]?.error ? <>
                          <p>Could not load images. {monthQueries[row.monthIndex]?.error?.message}</p>
                          <button className="btn mt-2" onClick={() => void monthQueries[row.monthIndex]?.refetch()}>Try again</button>
                        </> : "Loading images…"}
                      </div>
                    </div>
                  ) : row.type === "header" ? (
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
                            <div key={f.id} style={{ width: tileWidth(f, row.height, width - 36), height: row.height, padding: `0 ${PAD}px`, flex: "none" }}>
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
        {!timelineMode && items.length > 0 && activeQuery.isFetching && <p role="status" className="state-message">Loading images…</p>}
        </div>
        {showTimeline && (
          <TimelineScrubber buckets={buckets ?? []} heights={scrubberHeights} active={activeMonth} onSeek={seekToBucket} controls={scrollId} />
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
        <TagPromptDialog
          title={tagPrompt === "add" ? "Add tag" : "Remove tag"}
          label={`Tag to ${tagPrompt} on ${selection.size} file${selection.size === 1 ? "" : "s"}`}
          suggestFor={tagPrompt === "add" ? [...selection] : undefined}
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
    getItemKey: (i) => col[i]!.file.id,
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
