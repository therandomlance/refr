"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "refr/trpc/react";
import { ContextMenu, type MenuItem } from "refr/app/_components/context-menu";
import { ConfirmDialog } from "refr/app/_components/dialog";
import { Icon } from "refr/app/_components/icon";
import { Markdown } from "refr/app/_components/markdown";
import { Viewer } from "refr/app/_components/viewer";
import { publishViewerList } from "refr/app/_components/viewer-store";
import { GridOverlay, StudyFilterDefs } from "refr/app/_components/study-image";
import { studyFilter, GRID_MODES, VALUE_STEPS } from "refr/app/_components/study-tools";
import { isTypingTarget, matchViewerShortcut, overlayOpen } from "refr/lib/keyboard";
import { zoomAt, type ZoomState } from "refr/lib/zoom";
import {
  BOARD_ITEM_WIDTH,
  BOARD_ZOOM,
  NO_STUDY,
  cornerResize,
  resolveArrow,
  type Arrow,
  type ArrowEnd,
  type Board,
  type BoardItem,
  type BoardStudy,
  type Box,
  type Corner,
  type ImageItem,
  type Pt,
  type TextItem,
} from "refr/lib/boards";
import type { FileSummary } from "refr/server/services/search";
import { useBoardDoc } from "./use-board-doc";
import { BoardSuggestions } from "./board-suggestions";
import { ArrowPane, StudyPane, TextPane } from "./board-panes";

type Tool = "select" | "text" | "arrow";

type Gesture =
  | { kind: "pan"; sx: number; sy: number; view: ZoomState }
  | { kind: "pinch"; dist: number; mid: Pt; view: ZoomState }
  | {
      kind: "move";
      sx: number;
      sy: number;
      items: Map<string, Pt>;
      arrows: Map<string, { from: ArrowEnd; to: ArrowEnd }>;
      moved: boolean;
      /** a link pressed inside a text box — followed on release if nothing moved */
      link?: string;
    }
  | { kind: "resize"; id: string; corner: Corner; box: Box; aspect?: number }
  | { kind: "rotate"; id: string; cx: number; cy: number }
  | { kind: "arrow-end"; id: string; end: "from" | "to"; created: boolean };

/** thumbnails are ~512px on the long edge; past that on screen, load the original */
const THUMB_PX = 512;
const ARROW_PX = { s: 2, m: 4, l: 7 } as const;
const uid = () => crypto.randomUUID();

const viewKey = (name: string) => `refr:board-view:${name}`;
function readView(name: string): ZoomState | null {
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(name)) ?? "null") as ZoomState | null;
    return v && [v.x, v.y, v.zoom].every(Number.isFinite) && v.zoom > 0 ? v : null;
  } catch { return null; }
}

export function BoardCanvas({ name }: { name: string }) {
  const doc = useBoardDoc(name);
  const { board, apply, begin, end, cancel, undo, redo } = doc;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Tool>("select");
  const [editing, setEditingState] = useState<string | null>(null);
  // a ref too: the canvas pointerdown and the textarea blur both end an edit — only the first counts
  const editingRef = useRef<string | null>(null);
  const setEditing = (id: string | null) => { editingRef.current = id; setEditingState(id); };
  const editingCreated = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Pt>());
  // pointer capture retargets click/dblclick to the canvas, so remember what was pressed
  const pressedItem = useRef<string | null>(null);

  // ---- view: per device (localStorage), never part of the saved board
  const [view, setViewState] = useState<ZoomState | null>(null);
  const viewRef = useRef<ZoomState | null>(null);
  const viewTimer = useRef<number | undefined>(undefined);
  const setView = useCallback((fn: ZoomState | ((v: ZoomState) => ZoomState)) => {
    const prev = viewRef.current;
    if (!prev) return;
    const next = typeof fn === "function" ? fn(prev) : fn;
    viewRef.current = next;
    setViewState(next);
    window.clearTimeout(viewTimer.current);
    viewTimer.current = window.setTimeout(() => {
      try { localStorage.setItem(viewKey(name), JSON.stringify(next)); } catch { /* storage unavailable */ }
    }, 300);
  }, [name]);

  // ---- file metadata (aspect ratio, media type) for the board's images
  const fileIds = useMemo(
    () => [...new Set((board?.items ?? []).flatMap((i) => (i.kind === "image" ? [i.fileId] : [])))],
    [board?.items],
  );
  const filesQ = api.files.list.useQuery({ ids: fileIds }, { enabled: fileIds.length > 0, placeholderData: (prev) => prev });
  const meta = useMemo(() => new Map((filesQ.data?.items ?? []).map((f) => [f.id, f])), [filesQ.data]);
  const aspect = useCallback((fileId: string) => {
    const f = meta.get(fileId);
    return f?.width && f.height ? f.height / f.width : 1;
  }, [meta]);
  const boxOf = useCallback((it: BoardItem): Box =>
    it.kind === "image"
      ? { x: it.x, y: it.y, w: it.w, h: it.w * aspect(it.fileId), rot: it.rot }
      : { x: it.x, y: it.y, w: it.w, h: it.h, rot: 0 },
  [aspect]);
  const boxById = useCallback((b: Board) => {
    const byId = new Map(b.items.map((i) => [i.id, i]));
    return (itemId: string) => { const it = byId.get(itemId); return it ? boxOf(it) : null; };
  }, [boxOf]);

  const fitAll = useCallback((b: Board): ZoomState => {
    const el = canvasRef.current;
    const boxes = b.items.map(boxOf);
    if (!el || boxes.length === 0) return { x: el ? el.clientWidth / 2 : 0, y: el ? el.clientHeight / 2 : 0, zoom: 1 };
    const minX = Math.min(...boxes.map((r) => r.x));
    const minY = Math.min(...boxes.map((r) => r.y));
    const maxX = Math.max(...boxes.map((r) => r.x + r.w));
    const maxY = Math.max(...boxes.map((r) => r.y + r.h));
    const pad = 48;
    const z = Math.max(BOARD_ZOOM.min, Math.min(2, (el.clientWidth - pad * 2) / Math.max(1, maxX - minX), (el.clientHeight - pad * 2) / Math.max(1, maxY - minY)));
    return { zoom: z, x: (el.clientWidth - (maxX - minX) * z) / 2 - minX * z, y: (el.clientHeight - (maxY - minY) * z) / 2 - minY * z };
  }, [boxOf]);

  // first view: this device's last view of the board, else frame the content
  useEffect(() => {
    if (viewRef.current || !board || (fileIds.length > 0 && !filesQ.data)) return;
    const v = readView(name) ?? fitAll(board);
    viewRef.current = v;
    setViewState(v);
  }, [board, fileIds.length, filesQ.data, fitAll, name]);

  // ---- coordinates
  const toWorld = (clientX: number, clientY: number): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    const v = viewRef.current!;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  };
  const relCanvas = (clientX: number, clientY: number): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };
  const itemAt = (clientX: number, clientY: number, skip?: string): string | null => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const id = (el as HTMLElement).closest?.<HTMLElement>("[data-item]")?.dataset.item;
      if (id && id !== skip) return id;
    }
    return null;
  };

  // ---- wheel zoom (native: React's onWheel is passive). Mounted once the view exists.
  const hasView = view !== null;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".board-pane, .board-toolbar, textarea")) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const p = relCanvas(e.clientX, e.clientY);
      setView((v) => zoomAt(v, p, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), BOARD_ZOOM));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setView, hasView]);

  const zoomBy = (factor: number) => {
    const el = canvasRef.current;
    if (el) setView((v) => zoomAt(v, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, factor, BOARD_ZOOM));
  };

  // ---- selection helpers
  const selImages = (b: Board) => b.items.filter((i): i is ImageItem => i.kind === "image" && selected.has(i.id));
  const selTexts = (b: Board) => b.items.filter((i): i is TextItem => i.kind === "text" && selected.has(i.id));
  const selArrows = (b: Board) => b.arrows.filter((a) => selected.has(a.id));
  const mapSel = <T extends BoardItem>(b: Board, kind: T["kind"], fn: (i: T) => T): Board => ({
    ...b,
    items: b.items.map((i) => (i.kind === kind && selected.has(i.id) ? fn(i as T) : i)),
  });

  // ---- study tools (per image)
  const studyState = (b: Board) => {
    const imgs = selImages(b);
    const first = imgs[0];
    const st = (i: ImageItem) => i.study ?? NO_STUDY;
    return {
      flip: imgs.length > 0 && imgs.every((i) => i.flipX),
      gray: imgs.length > 0 && imgs.every((i) => st(i).gray),
      blur: imgs.length > 0 && imgs.every((i) => st(i).blur),
      value: first ? st(first).value : 0,
      grid: first ? st(first).grid : ("off" as const),
    };
  };
  const setStudy = (patch: (s: ReturnType<typeof studyState>) => Partial<BoardStudy & { flip: boolean }>) =>
    apply((b) => {
      const p = patch(studyState(b));
      return mapSel<ImageItem>(b, "image", (i) => {
        const { flip, ...study } = p;
        return { ...i, ...(flip !== undefined ? { flipX: flip } : {}), study: { ...(i.study ?? NO_STUDY), ...study } };
      });
    });
  const study = {
    flip: () => setStudy((s) => ({ flip: !s.flip })),
    gray: () => setStudy((s) => ({ gray: !s.gray })),
    blur: () => setStudy((s) => ({ blur: !s.blur })),
    value: () => setStudy((s) => ({ value: VALUE_STEPS[(VALUE_STEPS.indexOf(s.value) + 1) % VALUE_STEPS.length] })),
    grid: () => setStudy((s) => ({ grid: GRID_MODES[(GRID_MODES.indexOf(s.grid) + 1) % GRID_MODES.length] })),
  };

  // ---- item operations
  const removeSelected = () => {
    apply((b) => {
      const boxes = boxById(b);
      // arrows attached to a removed item keep their drawn position as a free end
      const arrows = b.arrows.filter((a) => !selected.has(a.id)).map((a) => {
        const hit = ("item" in a.from && selected.has(a.from.item)) || ("item" in a.to && selected.has(a.to.item));
        if (!hit) return a;
        const r = resolveArrow(a, boxes, 0);
        if (!r) return a;
        return {
          ...a,
          from: "item" in a.from && selected.has(a.from.item) ? r.from : a.from,
          to: "item" in a.to && selected.has(a.to.item) ? r.to : a.to,
        };
      });
      return { ...b, items: b.items.filter((i) => !selected.has(i.id)), arrows };
    });
    setSelected(new Set());
  };
  /** images ask first; text/arrows alone are one undo away */
  const requestRemove = () => {
    if (board && selImages(board).length > 0) setConfirmRemove(true);
    else removeSelected();
  };
  const toFront = () => apply((b) => ({ ...b, items: [...b.items.filter((i) => !selected.has(i.id)), ...b.items.filter((i) => selected.has(i.id))] }));
  const toBack = () => apply((b) => ({ ...b, items: [...b.items.filter((i) => selected.has(i.id)), ...b.items.filter((i) => !selected.has(i.id))] }));
  const resetRotation = () => apply((b) => mapSel<ImageItem>(b, "image", (i) => ({ ...i, rot: 0 })));
  const patchTexts = (patch: Partial<TextItem>) => apply((b) => mapSel<TextItem>(b, "text", (i) => ({ ...i, ...patch })));
  const patchArrows = (patch: Partial<Arrow>) => apply((b) => ({ ...b, arrows: b.arrows.map((a) => (selected.has(a.id) ? { ...a, ...patch } : a)) }));

  const addSuggested = useRef(0);
  const addImageAtCentre = (fileId: string) => {
    const el = canvasRef.current;
    if (!el || !viewRef.current) return;
    const c = toWorld(el.getBoundingClientRect().left + el.clientWidth / 2, el.getBoundingClientRect().top + el.clientHeight / 2);
    const jitter = (addSuggested.current++ % 6) * 28;
    const w = BOARD_ITEM_WIDTH * 0.75;
    apply((b) => ({
      ...b,
      items: [...b.items, { kind: "image", id: uid(), fileId, x: c.x - w / 2 + jitter, y: c.y - (w * aspect(fileId)) / 2 + jitter, w, rot: 0, flipX: false }],
    }));
  };

  // ---- text editing
  const startEdit = (id: string, created = false) => {
    begin();
    editingCreated.current = created;
    setEditing(id);
    setSelected(new Set([id]));
  };
  const finishEdit = (measuredH?: number) => {
    const id = editingRef.current;
    if (!id) return;
    setEditing(null);
    const it = doc.current.current?.items.find((i) => i.id === id);
    if (it?.kind === "text" && !it.text.trim()) {
      if (editingCreated.current) { cancel(); setSelected(new Set()); return; }
      apply((b) => ({ ...b, items: b.items.filter((i) => i.id !== id) }), false);
      setSelected(new Set());
    } else if (it?.kind === "text" && measuredH && measuredH > it.h + 1) {
      apply((b) => ({ ...b, items: b.items.map((i) => (i.id === id && i.kind === "text" ? { ...i, h: measuredH } : i)) }), false);
    }
    end();
  };
  const createText = (p: Pt) => {
    const t: TextItem = { kind: "text", id: uid(), x: p.x, y: p.y, w: 280, h: 72, text: "", size: "m", color: "fg", bg: "card", align: "left" };
    begin();
    apply((b) => ({ ...b, items: [...b.items, t] }), false);
    editingCreated.current = true;
    setEditing(t.id);
    setSelected(new Set([t.id]));
    setTool("select");
  };

  // ---- viewer
  const openViewer = (ids: string[], fileId: string) => {
    // (metadata may still be loading: fall back to a bare summary)
    const list: FileSummary[] = [...new Set(ids)].map(
      (id) => meta.get(id) ?? { id, mediaType: "image", width: null, height: null, duration: null, mtime: 0 },
    );
    publishViewerList({ items: list, loadMore: null, hasMore: false });
    setViewer(fileId);
  };
  const closeViewer = () => {
    setViewer(null);
    const p = new URLSearchParams(window.location.search);
    p.delete("v");
    window.history.replaceState(null, "", `${window.location.pathname}${p.size ? `?${p.toString()}` : ""}`);
  };

  // ---- keyboard
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e) => {
    if (isTypingTarget(e.target) || overlayOpen() || !board || !viewRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey) {
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
      else if (k === "a") { e.preventDefault(); setSelected(new Set([...board.items.map((i) => i.id), ...board.arrows.map((a) => a.id)])); }
      return;
    }
    if (e.altKey) return;
    if (e.key === " ") { e.preventDefault(); setSpaceDown(true); return; }
    if (e.key === "Escape") { if (tool !== "select") setTool("select"); else setSelected(new Set()); return; }
    if (k === "a" && !e.shiftKey) { setTool((t) => (t === "arrow" ? "select" : "arrow")); return; }
    const action = matchViewerShortcut(e);
    if (action === "resetZoom") { setView(fitAll(board)); return; }
    if (selected.size === 0) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); requestRemove(); }
    else if (e.key === "Enter") {
      const texts = selTexts(board);
      if (texts.length === 1) { e.preventDefault(); startEdit(texts[0]!.id); }
    }
    else if (e.key === "]") toFront();
    else if (e.key === "[") toBack();
    else if (selImages(board).length > 0 && action && action in study) study[action as keyof typeof study]();
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => { if (e.key === " ") setSpaceDown(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // ---- pointer gestures
  const onPointerDown = (e: React.PointerEvent) => {
    if (!board || !viewRef.current || e.button === 2) return;
    if (editingRef.current) finishEdit(document.querySelector<HTMLElement>(".board-text.editing")?.offsetHeight);
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // a second finger turns whatever was happening into a pinch
      if (gesture.current && gesture.current.kind !== "pan") end();
      const [a, b] = [...pointers.current.values()] as [Pt, Pt];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: relCanvas((a.x + b.x) / 2, (a.y + b.y) / 2), view: viewRef.current };
      return;
    }
    if (pointers.current.size > 2) return;
    const target = e.target as HTMLElement;
    const world = toWorld(e.clientX, e.clientY);

    if (spaceDown || e.button === 1) {
      gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, view: viewRef.current };
      return;
    }
    if (tool === "text") { createText(world); return; }
    if (tool === "arrow") {
      const on = itemAt(e.clientX, e.clientY);
      const a: Arrow = { id: uid(), from: on ? { item: on } : world, to: world, color: "fg", width: "m", heads: "end", dashed: false };
      begin();
      apply((b) => ({ ...b, arrows: [...b.arrows, a] }), false);
      setSelected(new Set([a.id]));
      gesture.current = { kind: "arrow-end", id: a.id, end: "to", created: true };
      return;
    }

    const endHandle = target.closest<SVGElement>("[data-arrow-end]");
    if (endHandle) {
      begin();
      gesture.current = { kind: "arrow-end", id: endHandle.dataset.arrow!, end: endHandle.dataset.arrowEnd as "from" | "to", created: false };
      return;
    }
    const itemEl = target.closest<HTMLElement>("[data-item]");
    const arrowId = target.closest<SVGElement>("[data-arrow]")?.dataset.arrow;
    const id = itemEl?.dataset.item ?? arrowId;
    pressedItem.current = itemEl?.dataset.item ?? null;
    if (!id) {
      if (!e.shiftKey && e.button === 0) setSelected(new Set());
      gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, view: viewRef.current };
      return;
    }
    const item = board.items.find((i) => i.id === id);
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    if (item && handle === "rotate" && item.kind === "image") {
      const r = itemEl!.getBoundingClientRect();
      begin();
      gesture.current = { kind: "rotate", id, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      return;
    }
    if (item && handle) {
      // text boxes can render taller than their stored height (content grows them)
      const box = item.kind === "text" ? { ...boxOf(item), h: Math.max(item.h, itemEl!.offsetHeight) } : boxOf(item);
      begin();
      gesture.current = { kind: "resize", id, corner: handle as Corner, box, aspect: item.kind === "image" ? aspect(item.fileId) : undefined };
      return;
    }
    let next = selected;
    if (e.shiftKey) {
      next = new Set(selected);
      if (next.has(id)) next.delete(id); else next.add(id);
    } else if (!selected.has(id)) {
      next = new Set([id]);
    }
    setSelected(next);
    begin();
    gesture.current = {
      kind: "move",
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      link: target.closest("a")?.getAttribute("href") ?? undefined,
      items: new Map(board.items.filter((i) => next.has(i.id)).map((i) => [i.id, { x: i.x, y: i.y }])),
      arrows: new Map(board.arrows.filter((a) => next.has(a.id)).map((a) => [a.id, { from: a.from, to: a.to }])),
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const v = viewRef.current;
    if (!g || !v) return;
    switch (g.kind) {
      case "pan":
        setView({ ...g.view, x: g.view.x + e.clientX - g.sx, y: g.view.y + e.clientY - g.sy });
        break;
      case "pinch": {
        const [a, b] = [...pointers.current.values()] as [Pt, Pt | undefined];
        if (!b) break;
        const mid = relCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
        const z = zoomAt(g.view, g.mid, Math.hypot(a.x - b.x, a.y - b.y) / g.dist, BOARD_ZOOM);
        setView({ zoom: z.zoom, x: z.x + mid.x - g.mid.x, y: z.y + mid.y - g.mid.y });
        break;
      }
      case "move": {
        const dx = (e.clientX - g.sx) / v.zoom;
        const dy = (e.clientY - g.sy) / v.zoom;
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 3) break;
        g.moved = true;
        const shift = (end: ArrowEnd): ArrowEnd => ("item" in end ? end : { x: end.x + dx, y: end.y + dy });
        apply((b) => ({
          ...b,
          items: b.items.map((i) => {
            const s = g.items.get(i.id);
            return s ? { ...i, x: s.x + dx, y: s.y + dy } : i;
          }),
          arrows: b.arrows.map((a) => {
            const s = g.arrows.get(a.id);
            return s ? { ...a, from: shift(s.from), to: shift(s.to) } : a;
          }),
        }), false);
        break;
      }
      case "resize": {
        const r = cornerResize(g.box, g.corner, toWorld(e.clientX, e.clientY), g.aspect);
        apply((b) => ({
          ...b,
          items: b.items.map((i) => (i.id !== g.id ? i : i.kind === "image" ? { ...i, x: r.x, y: r.y, w: r.w } : { ...i, ...r })),
        }), false);
        break;
      }
      case "rotate": {
        let deg = (Math.atan2(e.clientY - g.cy, e.clientX - g.cx) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        deg = ((deg % 360) + 360) % 360;
        apply((b) => ({ ...b, items: b.items.map((i) => (i.id === g.id && i.kind === "image" ? { ...i, rot: deg } : i)) }), false);
        break;
      }
      case "arrow-end": {
        const p = toWorld(e.clientX, e.clientY);
        apply((b) => ({ ...b, arrows: b.arrows.map((a) => (a.id === g.id ? { ...a, [g.end]: p } : a)) }), false);
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === "pinch") {
      if (pointers.current.size === 1 && viewRef.current) {
        // lifting one finger of a pinch continues as a pan from the remaining one
        const [p] = [...pointers.current.values()] as [Pt];
        gesture.current = { kind: "pan", sx: p.x, sy: p.y, view: viewRef.current };
      } else if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "arrow-end") {
      const b = doc.current.current!;
      const a = b.arrows.find((x) => x.id === g.id);
      const otherEnd = a?.[g.end === "to" ? "from" : "to"];
      const on = itemAt(e.clientX, e.clientY);
      if (a && on && !(otherEnd && "item" in otherEnd && otherEnd.item === on)) {
        apply((bd) => ({ ...bd, arrows: bd.arrows.map((x) => (x.id === g.id ? { ...x, [g.end]: { item: on } } : x)) }), false);
      }
      const r = a && resolveArrow(doc.current.current!.arrows.find((x) => x.id === g.id)!, boxById(doc.current.current!), 0);
      if (g.created && r && Math.hypot(r.to.x - r.from.x, r.to.y - r.from.y) * (viewRef.current?.zoom ?? 1) < 10) {
        cancel(); // a click with the arrow tool, not a drag
        setSelected(new Set());
      } else end();
      setTool("select");
      return;
    }
    if (g.kind === "move" && !g.moved && g.link) window.open(g.link, "_blank", "noopener,noreferrer");
    if (g.kind !== "pan") end();
  };

  // ---- render
  if (doc.query.isError) {
    return <div role="alert" className="state-message m-auto">Could not load this board. <button className="btn" onClick={() => void doc.query.refetch()}>Try again</button></div>;
  }
  if (!board) return <p role="status" className="state-message m-auto">Loading board…</p>;

  const v = view ?? { x: 0, y: 0, zoom: 1 };
  const single = selected.size === 1;
  const imagesSel = selImages(board);
  const textsSel = selTexts(board);
  const arrowsSel = selArrows(board);
  const anyItemsSel = imagesSel.length + textsSel.length > 0;
  const imageCount = board.items.filter((i) => i.kind === "image").length;
  const boxes = boxById(board);
  const imageIds = board.items.flatMap((i) => (i.kind === "image" ? [i.fileId] : []));

  const menuItems: MenuItem[] = [];
  if (single && imagesSel[0]) menuItems.push({ label: "Open in viewer", onClick: () => openViewer(imageIds, imagesSel[0]!.fileId) });
  if (single && textsSel[0]) menuItems.push({ label: "Edit text", hint: "Enter", onClick: () => startEdit(textsSel[0]!.id) });
  if (imagesSel.length) {
    menuItems.push(
      { label: "Flip horizontally", hint: "H", onClick: study.flip },
      { label: "Reset rotation", onClick: resetRotation },
    );
  }
  if (anyItemsSel) menuItems.push({ label: "Bring to front", hint: "]", onClick: toFront }, { label: "Send to back", hint: "[", onClick: toBack });
  if (menuItems.length) menuItems.push("sep");
  menuItems.push({ label: selected.size > 1 ? `Remove ${selected.size} from board…` : "Remove from board…", hint: "Del", onClick: requestRemove, danger: true });

  const stopUi = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{name}</h1>
          <p>{imageCount} image{imageCount === 1 ? "" : "s"} · {doc.saving ? "Saving…" : "Saved"}</p>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div
          ref={canvasRef}
          className={`board-canvas tool-${tool}${spaceDown ? " panning" : ""}`}
          style={{ backgroundPosition: `${v.x}px ${v.y}px`, backgroundSize: `${24 * v.zoom}px ${24 * v.zoom}px` }}
          onPointerDownCapture={() => { pressedItem.current = null; }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            const id = pressedItem.current;
            const it = id ? board.items.find((i) => i.id === id) : null;
            if (it?.kind === "image") openViewer(imageIds, it.fileId);
            else if (it?.kind === "text") startEdit(it.id);
            else if (!id && !(e.target as Element).closest("[data-arrow]")) createText(toWorld(e.clientX, e.clientY));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const t = e.target as Element;
            const id = t.closest<HTMLElement>("[data-item]")?.dataset.item ?? t.closest<SVGElement>("[data-arrow]")?.dataset.arrow;
            if (!id) return;
            if (!selected.has(id)) setSelected(new Set([id]));
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <StudyFilterDefs />
          {view && (
            <div
              className="board-world"
              style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`, "--z": 1 / v.zoom, "--zoom": v.zoom } as React.CSSProperties}
            >
              {board.items.map((it) =>
                it.kind === "image" ? (
                  <ImageTile
                    key={it.id}
                    item={it}
                    height={it.w * aspect(it.fileId)}
                    selected={selected.has(it.id)}
                    handles={single && selected.has(it.id)}
                    full={it.w * v.zoom > THUMB_PX && meta.get(it.fileId)?.mediaType === "image"}
                  />
                ) : (
                  <TextTile
                    key={it.id}
                    item={it}
                    selected={selected.has(it.id)}
                    handles={single && selected.has(it.id) && editing !== it.id}
                    editing={editing === it.id}
                    onText={(text, minH) => apply((b) => ({
                      ...b,
                      items: b.items.map((i) => (i.id === it.id && i.kind === "text" ? { ...i, text, h: Math.max(i.h, minH) } : i)),
                    }), false)}
                    onDone={finishEdit}
                  />
                ),
              )}
              <svg className="board-arrows" aria-hidden="true">
                {board.arrows.map((a) => {
                  const r = resolveArrow(a, boxes);
                  return r ? <ArrowShape key={a.id} arrow={a} from={r.from} to={r.to} selected={selected.has(a.id)} /> : null;
                })}
              </svg>
            </div>
          )}

          {board.items.length === 0 && (
            <div className="state-message board-empty">
              This board is empty. Select images in Search, Browse or Queue and press <kbd>B</kbd>, or double-click here to add text.
            </div>
          )}

          <div className="board-panes" {...stopUi}>
            {imagesSel.length > 0 && (
              <StudyPane state={studyState(board)} onFlip={study.flip} onGray={study.gray} onBlur={study.blur} onValue={study.value} onGrid={study.grid} />
            )}
            {textsSel[0] && <TextPane text={textsSel[0]} onChange={patchTexts} onEdit={() => startEdit(textsSel[0]!.id)} />}
            {arrowsSel[0] && <ArrowPane arrow={arrowsSel[0]} onChange={patchArrows} />}
          </div>

          <div className="board-toolbar" role="toolbar" aria-label="Board" {...stopUi}>
            <button type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!doc.canUndo} onClick={undo}><Icon name="undo" /></button>
            <button type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!doc.canRedo} onClick={redo}><Icon name="redo" /></button>
            <span className="sep" />
            <button type="button" className={tool === "select" ? "on" : ""} aria-pressed={tool === "select"} title="Select (Esc)" aria-label="Select tool" onClick={() => setTool("select")}><Icon name="cursor" /></button>
            <button type="button" className={tool === "text" ? "on" : ""} aria-pressed={tool === "text"} title="Text box (or double-click the board)" aria-label="Text tool" onClick={() => setTool(tool === "text" ? "select" : "text")}><Icon name="text" /></button>
            <button type="button" className={tool === "arrow" ? "on" : ""} aria-pressed={tool === "arrow"} title="Arrow (A) — start or end on an item to attach" aria-label="Arrow tool" onClick={() => setTool(tool === "arrow" ? "select" : "arrow")}><Icon name="arrow" /></button>
            {selected.size > 0 && (
              <>
                <span className="sep" />
                {anyItemsSel && <button type="button" title="Bring to front (])" onClick={toFront}>Front</button>}
                {anyItemsSel && <button type="button" title="Send to back ([)" onClick={toBack}>Back</button>}
                <button type="button" className="danger" title="Remove from board (Del)" aria-label="Remove from board" onClick={requestRemove}><Icon name="close" /></button>
              </>
            )}
            <span className="sep" />
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
            <button type="button" title="Zoom to 100%" onClick={() => {
              const el = canvasRef.current;
              if (el) setView((cur) => zoomAt(cur, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, 1 / cur.zoom, BOARD_ZOOM));
            }}>{Math.round(v.zoom * 100)}%</button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
            <button type="button" title="Fit all (0)" onClick={() => setView(fitAll(board))}>Fit</button>
          </div>
        </div>

        <BoardSuggestions
          fileIds={fileIds}
          hidden={board.hidden}
          onAdd={addImageAtCentre}
          onHide={(id) => apply((b) => ({ ...b, hidden: [...b.hidden, id] }), false)}
          onResetHidden={() => apply((b) => ({ ...b, hidden: [] }), false)}
          onOpen={openViewer}
        />
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} />}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove from board"
          body={<>Remove {selected.size === 1 ? "this item" : `${selected.size} items`} from <b>{name}</b>? The images stay in your library, and Undo brings them back.</>}
          confirmLabel="Remove"
          danger
          onConfirm={removeSelected}
          onClose={() => setConfirmRemove(false)}
        />
      )}
      {viewer && <Viewer fileId={viewer} onClose={closeViewer} />}
    </>
  );
}

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

function Handles({ rotate }: { rotate: boolean }) {
  return (
    <>
      {CORNERS.map((c) => <div key={c} data-handle={c} className={`board-handle corner ${c}`} aria-hidden="true" />)}
      {rotate && <div data-handle="rotate" className="board-handle rotate" aria-hidden="true" />}
    </>
  );
}

function ImageTile({ item, height, selected, handles, full }: {
  item: ImageItem;
  height: number;
  selected: boolean;
  handles: boolean;
  /** shown big enough on screen that the thumbnail would look soft */
  full: boolean;
}) {
  const s = item.study ?? NO_STUDY;
  return (
    <div
      data-item={item.id}
      className={`board-item${selected ? " sel" : ""}`}
      style={{ left: item.x, top: item.y, width: item.w, height, transform: item.rot ? `rotate(${item.rot}deg)` : undefined }}
    >
      <div className="board-img" style={item.flipX ? { transform: "scaleX(-1)" } : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={full ? `/api/file/${item.fileId}` : `/api/thumb/${item.fileId}`}
          alt=""
          draggable={false}
          style={{ filter: studyFilter({ flip: item.flipX, ...s }) }}
        />
        <GridOverlay grid={s.grid} />
      </div>
      {handles && <Handles rotate />}
    </div>
  );
}

function TextTile({ item, selected, handles, editing, onText, onDone }: {
  item: TextItem;
  selected: boolean;
  handles: boolean;
  editing: boolean;
  onText: (text: string, minH: number) => void;
  onDone: (measuredH?: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const done = () => onDone(ref.current?.offsetHeight);
  return (
    <div
      ref={ref}
      data-item={item.id}
      className={`board-item board-text size-${item.size} c-${item.color} bg-${item.bg} align-${item.align}${selected ? " sel" : ""}${editing ? " editing" : ""}`}
      style={{ left: item.x, top: item.y, width: item.w, minHeight: item.h }}
    >
      {editing ? (
        <textarea
          autoFocus
          value={item.text}
          aria-label="Text box (markdown)"
          placeholder="Type… **bold**, *italic*, # heading, - list"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
            onText(el.value, el.scrollHeight);
          }}
          ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}
          onBlur={done}
          onKeyDown={(e) => {
            if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.currentTarget.blur(); }
          }}
        />
      ) : item.text.trim() ? (
        <Markdown text={item.text} />
      ) : (
        <p className="board-text-empty">Double-click to edit</p>
      )}
      {handles && <Handles rotate={false} />}
    </div>
  );
}

function ArrowShape({ arrow, from, to, selected }: { arrow: Arrow; from: Pt; to: Pt; selected: boolean }) {
  const w = ARROW_PX[arrow.width];
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const u = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  const n = { x: -u.y, y: u.x };
  const head = Math.min(len / 2, 8 + w * 3);
  const headPts = (tip: Pt, dir: Pt) =>
    [tip, { x: tip.x - dir.x * head + n.x * head * 0.55, y: tip.y - dir.y * head + n.y * head * 0.55 }, { x: tip.x - dir.x * head - n.x * head * 0.55, y: tip.y - dir.y * head - n.y * head * 0.55 }]
      .map((p) => `${p.x},${p.y}`).join(" ");
  const endHead = arrow.heads !== "none";
  const startHead = arrow.heads === "both";
  // stop the line short of the heads so thick lines don't poke past the tips
  const a = startHead ? { x: from.x + u.x * head * 0.7, y: from.y + u.y * head * 0.7 } : from;
  const b = endHead ? { x: to.x - u.x * head * 0.7, y: to.y - u.y * head * 0.7 } : to;
  return (
    <g data-arrow={arrow.id} className={`board-arrow c-${arrow.color}${selected ? " sel" : ""}`}>
      <line className="hit" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
      {selected && <line className="halo" x1={from.x} y1={from.y} x2={to.x} y2={to.y} style={{ strokeWidth: `calc(${w}px + 6px * var(--z))` }} />}
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={w} strokeDasharray={arrow.dashed ? `${w * 3} ${w * 2.5}` : undefined} />
      {endHead && <polygon points={headPts(to, u)} />}
      {startHead && <polygon points={headPts(from, { x: -u.x, y: -u.y })} />}
      {selected && (
        <>
          <circle data-arrow={arrow.id} data-arrow-end="from" className="end" cx={from.x} cy={from.y} />
          <circle data-arrow={arrow.id} data-arrow-end="to" className="end" cx={to.x} cy={to.y} />
        </>
      )}
    </g>
  );
}
