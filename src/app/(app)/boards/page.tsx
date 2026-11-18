"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { SidePanel } from "refr/app/_components/side-panel";
import { ContextMenu, type MenuItem } from "refr/app/_components/context-menu";
import { ConfirmDialog, PromptDialog } from "refr/app/_components/dialog";
import { Icon } from "refr/app/_components/icon";
import { Viewer } from "refr/app/_components/viewer";
import { publishViewerList } from "refr/app/_components/viewer-store";
import { isTypingTarget, overlayOpen } from "refr/lib/keyboard";
import { zoomAt, type ZoomState } from "refr/lib/zoom";
import { BOARD_ZOOM, type Board, type BoardItem } from "refr/lib/boards";
import type { FileSummary } from "refr/server/services/search";

export default function BoardsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const utils = api.useUtils();
  const boards = api.boards.list.useQuery();
  const [newPrompt, setNewPrompt] = useState(false);
  const [renameOf, setRenameOf] = useState<string | null>(null);
  const [deleteOf, setDeleteOf] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);

  const open = (name: string | null) =>
    router.replace(name ? `/boards?b=${encodeURIComponent(name)}` : "/boards");
  // default to the most recently changed board
  const requested = params.get("b");
  const current = requested ?? boards.data?.[0]?.name ?? null;

  const create = api.boards.create.useMutation({
    meta: { customFeedback: true },
    onSuccess: (name) => { void utils.boards.list.invalidate(); open(name); },
  });
  const rename = api.boards.rename.useMutation({
    meta: { customFeedback: true },
    onSuccess: (name, v) => {
      void utils.boards.invalidate();
      if (current === v.from) open(name);
    },
  });
  const remove = api.boards.delete.useMutation({
    meta: { customFeedback: true },
    onSuccess: (_r, v) => {
      void utils.boards.list.invalidate();
      if (current === v.name) open(null);
    },
  });

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel
        head={
          <>
            <div>
              <h2 className="text-[13px] font-semibold">Boards</h2>
              <p className="mt-1 text-xs text-fg-subtle">{boards.data?.length ?? 0} boards</p>
            </div>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => setNewPrompt(true)}>New</button>
          </>
        }
      >
        <div className="flex-1 px-2 pb-4">
          {(boards.data ?? []).map((b) => (
            <div
              key={b.name}
              className={`trow ${b.name === current ? "sel" : ""}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ name: b.name, x: e.clientX, y: e.clientY });
              }}
            >
              <button type="button" className="tree-select" aria-current={b.name === current ? "page" : undefined} onClick={() => open(b.name)}>{b.name}</button>
              <span className="count">{b.count}</span>
              <button type="button" className="tree-actions" aria-label={`Actions for ${b.name}`} onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ name: b.name, x: r.left, y: r.bottom });
              }}><Icon name="more" /></button>
            </div>
          ))}
          {boards.data?.length === 0 && (
            <p className="px-2 text-xs text-fg-subtle">No boards yet. Create one, or select images in any grid and press B.</p>
          )}
        </div>
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <BoardCanvas key={current} name={current} />
        ) : (
          <>
            <header className="page-header"><div><h1>Boards</h1><p>Freeform reference boards.</p></div></header>
            <div className="state-message m-auto">
              {boards.isLoading ? "Loading…" : "Create a board, or select images in Search, Browse or Queue and press B."}
            </div>
          </>
        )}
      </main>

      {newPrompt && (
        <PromptDialog title="New board" label="Board name" onSubmit={(name) => create.mutate({ name })} onClose={() => setNewPrompt(false)} />
      )}
      {renameOf && (
        <PromptDialog
          title="Rename board"
          label="Board name"
          initial={renameOf}
          onSubmit={(to) => rename.mutate({ from: renameOf, to })}
          onClose={() => setRenameOf(null)}
        />
      )}
      {deleteOf && (
        <ConfirmDialog
          title="Delete board"
          body={<>Delete <b>{deleteOf}</b>? The images stay in your library.</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => remove.mutate({ name: deleteOf })}
          onClose={() => setDeleteOf(null)}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename…", onClick: () => setRenameOf(menu.name) },
            { label: "Delete…", onClick: () => setDeleteOf(menu.name), danger: true },
          ]}
        />
      )}
    </div>
  );
}

type Gesture =
  | { kind: "pan"; sx: number; sy: number; view: ZoomState }
  | { kind: "move"; sx: number; sy: number; starts: Map<string, { x: number; y: number }> }
  | { kind: "resize"; id: string; sx: number; sy: number; w: number; rot: number }
  | { kind: "rotate"; id: string; cx: number; cy: number }
  | { kind: "pinch"; dist: number; mid: { x: number; y: number }; view: ZoomState };

const SAVE_DEBOUNCE_MS = 600;
/** thumbnails are ~512px on the long edge; past that on screen, load the original */
const THUMB_PX = 512;

function BoardCanvas({ name }: { name: string }) {
  const utils = api.useUtils();
  const q = api.boards.get.useQuery({ name }, { refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity });
  const save = api.boards.save.useMutation({
    meta: { customFeedback: true, silent: true },
    onSuccess: () => void utils.boards.list.invalidate(),
  });

  const [board, setBoard] = useState<Board | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [status, setStatus] = useState<"saved" | "unsaved">("saved");
  const canvasRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // pointer capture retargets click/dblclick to the canvas, so remember what was pressed
  const pressedItem = useRef<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  // ---- autosave: local state is the source of truth once loaded
  const latest = useRef<Board | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const saveMutate = save.mutate;
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!dirty.current || !latest.current) return;
    dirty.current = false;
    setStatus("saved");
    // ponytail: last-write-wins; renaming a board within the debounce window drops that edit
    saveMutate({ name, board: latest.current });
  }, [name, saveMutate]);
  useEffect(() => () => flush(), [flush]);

  const update = useCallback((fn: (b: Board) => Board) => {
    setBoard((b) => {
      if (!b) return b;
      const next = fn(b);
      latest.current = next;
      return next;
    });
    dirty.current = true;
    setStatus("unsaved");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => {
    if (q.data && !board) {
      setBoard(q.data);
      latest.current = q.data;
    }
  }, [q.data, board]);

  // ---- file metadata (aspect ratio, media type) for every file on the board
  const fileIds = useMemo(() => [...new Set((board?.items ?? []).map((i) => i.fileId))], [board?.items]);
  const filesQ = api.files.list.useQuery({ ids: fileIds }, { enabled: fileIds.length > 0, placeholderData: (prev) => prev });
  const meta = useMemo(() => new Map((filesQ.data?.items ?? []).map((f) => [f.id, f])), [filesQ.data]);
  const aspect = (fileId: string) => {
    const f = meta.get(fileId);
    return f?.width && f.height ? f.height / f.width : 1;
  };

  const fitAll = useCallback((b: Board): ZoomState => {
    const el = canvasRef.current;
    if (!el || b.items.length === 0) return { x: 0, y: 0, zoom: 1 };
    const minX = Math.min(...b.items.map((i) => i.x));
    const minY = Math.min(...b.items.map((i) => i.y));
    const maxX = Math.max(...b.items.map((i) => i.x + i.w));
    const maxY = Math.max(...b.items.map((i) => i.y + i.w * aspect(i.fileId)));
    const pad = 48;
    const zoom = Math.min(2, (el.clientWidth - pad * 2) / Math.max(1, maxX - minX), (el.clientHeight - pad * 2) / Math.max(1, maxY - minY));
    const z = Math.max(BOARD_ZOOM.min, zoom);
    return {
      zoom: z,
      x: (el.clientWidth - (maxX - minX) * z) / 2 - minX * z,
      y: (el.clientHeight - (maxY - minY) * z) / 2 - minY * z,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // first open of a board that was only ever filled via "Add to board": frame its content
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || !board || (fileIds.length > 0 && !filesQ.data)) return;
    framed.current = true;
    const v = board.view;
    if (board.items.length && v.x === 0 && v.y === 0 && v.zoom === 1) {
      setBoard((b) => (b ? { ...b, view: fitAll(b) } : b));
    }
  }, [board, fileIds.length, filesQ.data, fitAll]);

  // ---- wheel zoom (native: React's onWheel is passive). The canvas mounts with the board.
  const loaded = board !== null;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      update((b) => ({ ...b, view: zoomAt(b.view, p, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), BOARD_ZOOM) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [update, loaded]);

  const zoomBy = (factor: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const p = { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    update((b) => ({ ...b, view: zoomAt(b.view, p, factor, BOARD_ZOOM) }));
  };

  // ---- item operations (on the selection)
  const sel = (b: Board) => b.items.filter((i) => selected.has(i.id));
  const removeSelected = () => { update((b) => ({ ...b, items: b.items.filter((i) => !selected.has(i.id)) })); setSelected(new Set()); };
  const flipSelected = () => update((b) => ({ ...b, items: b.items.map((i) => (selected.has(i.id) ? { ...i, flipX: !i.flipX } : i)) }));
  const toFront = () => update((b) => ({ ...b, items: [...b.items.filter((i) => !selected.has(i.id)), ...sel(b)] }));
  const toBack = () => update((b) => ({ ...b, items: [...sel(b), ...b.items.filter((i) => !selected.has(i.id))] }));
  const resetRotation = () => update((b) => ({ ...b, items: b.items.map((i) => (selected.has(i.id) ? { ...i, rot: 0 } : i)) }));

  const openViewer = (fileId: string) => {
    if (!board) return;
    // board order (back → front) as the viewer's prev/next list
    // (metadata may still be loading: fall back to a bare summary, as browse does)
    const list: FileSummary[] = [...new Set(board.items.map((i) => i.fileId))].map(
      (id) => meta.get(id) ?? { id, mediaType: "image", width: null, height: null, duration: null, mtime: 0 },
    );
    publishViewerList({ items: list, loadMore: null, hasMore: false });
    setViewerId(fileId);
  };
  const closeViewer = () => {
    setViewerId(null);
    const p = new URLSearchParams(window.location.search);
    p.delete("v");
    window.history.replaceState(null, "", `${window.location.pathname}${p.size ? `?${p.toString()}` : ""}`);
  };

  // ---- keyboard
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e) => {
    if (isTypingTarget(e.target) || overlayOpen() || !board) return;
    if (e.key === " ") { e.preventDefault(); setSpaceDown(true); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(board.items.map((i) => i.id))); return; }
    if (mod || e.altKey) return;
    if (e.key === "Escape") setSelected(new Set());
    else if (e.key === "0") update((b) => ({ ...b, view: fitAll(b) }));
    else if (selected.size === 0) return;
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); }
    else if (e.key.toLowerCase() === "h") flipSelected();
    else if (e.key === "]") toFront();
    else if (e.key === "[") toBack();
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => { if (e.key === " ") setSpaceDown(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // ---- pointer gestures: pan (empty space / space-drag / middle button / two
  // fingers pinch), move selection, resize + rotate via the single-selection handles
  const rel = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!board || e.button === 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }), view: board.view };
      return;
    }
    if (pointers.current.size > 2) return;
    const target = e.target as HTMLElement;
    const itemEl = target.closest<HTMLElement>("[data-item]");
    pressedItem.current = itemEl?.dataset.item ?? null;
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    if (spaceDown || e.button === 1 || !itemEl) {
      if (!itemEl && !e.shiftKey && !spaceDown && e.button === 0) setSelected(new Set());
      gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, view: board.view };
      return;
    }
    const id = itemEl.dataset.item!;
    const item = board.items.find((i) => i.id === id);
    if (!item) return;
    if (handle === "resize") {
      gesture.current = { kind: "resize", id, sx: e.clientX, sy: e.clientY, w: item.w, rot: item.rot };
      return;
    }
    if (handle === "rotate") {
      const r = itemEl.getBoundingClientRect();
      gesture.current = { kind: "rotate", id, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
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
    const starts = new Map(board.items.filter((i) => next.has(i.id)).map((i) => [i.id, { x: i.x, y: i.y }]));
    gesture.current = { kind: "move", sx: e.clientX, sy: e.clientY, starts };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g || !board) return;
    const zoom = board.view.zoom;
    switch (g.kind) {
      case "pan":
        update((b) => ({ ...b, view: { ...g.view, x: g.view.x + e.clientX - g.sx, y: g.view.y + e.clientY - g.sy } }));
        break;
      case "pinch": {
        const [a, b2] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
        if (!b2) break;
        const mid = rel({ clientX: (a.x + b2.x) / 2, clientY: (a.y + b2.y) / 2 });
        const z = zoomAt(g.view, g.mid, Math.hypot(a.x - b2.x, a.y - b2.y) / g.dist, BOARD_ZOOM);
        update((b) => ({ ...b, view: { zoom: z.zoom, x: z.x + mid.x - g.mid.x, y: z.y + mid.y - g.mid.y } }));
        break;
      }
      case "move": {
        const dx = (e.clientX - g.sx) / zoom;
        const dy = (e.clientY - g.sy) / zoom;
        update((b) => ({
          ...b,
          items: b.items.map((i) => {
            const s = g.starts.get(i.id);
            return s ? { ...i, x: s.x + dx, y: s.y + dy } : i;
          }),
        }));
        break;
      }
      case "resize": {
        // project the drag onto the item's own (rotated) x axis
        // ponytail: rotation pivots on the centre, so resizing a rotated item drifts slightly
        const t = (g.rot * Math.PI) / 180;
        const along = ((e.clientX - g.sx) * Math.cos(t) + (e.clientY - g.sy) * Math.sin(t)) / zoom;
        update((b) => ({ ...b, items: b.items.map((i) => (i.id === g.id ? { ...i, w: Math.max(40, g.w + along) } : i)) }));
        break;
      }
      case "rotate": {
        let deg = (Math.atan2(e.clientY - g.cy, e.clientX - g.cx) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        deg = ((deg % 360) + 360) % 360;
        update((b) => ({ ...b, items: b.items.map((i) => (i.id === g.id ? { ...i, rot: deg } : i)) }));
        break;
      }
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (gesture.current?.kind === "pinch" && pointers.current.size === 1) {
      // lifting one finger of a pinch continues as a pan from the remaining one
      const [p] = [...pointers.current.values()] as [{ x: number; y: number }];
      gesture.current = board ? { kind: "pan", sx: p.x, sy: p.y, view: board.view } : null;
      return;
    }
    if (pointers.current.size === 0) gesture.current = null;
  };

  if (q.isError) {
    return <div role="alert" className="state-message m-auto">Could not load this board. <button className="btn" onClick={() => void q.refetch()}>Try again</button></div>;
  }
  if (!board) return <p role="status" className="state-message m-auto">Loading board…</p>;

  const v = board.view;
  const single = selected.size === 1;
  const menuItems: MenuItem[] = [
    ...(single ? [{ label: "Open in viewer", onClick: () => { const it = board.items.find((i) => selected.has(i.id)); if (it) openViewer(it.fileId); } }] : []),
    { label: "Flip horizontally", hint: "H", onClick: flipSelected },
    { label: "Reset rotation", onClick: resetRotation },
    { label: "Bring to front", hint: "]", onClick: toFront },
    { label: "Send to back", hint: "[", onClick: toBack },
    "sep",
    { label: selected.size > 1 ? `Remove ${selected.size} from board` : "Remove from board", hint: "Del", onClick: removeSelected, danger: true },
  ];

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{name}</h1>
          <p>{board.items.length} image{board.items.length === 1 ? "" : "s"} · {status === "unsaved" || save.isPending ? "Saving…" : "Saved"}</p>
        </div>
      </header>
      <div
        ref={canvasRef}
        className={`board-canvas${spaceDown ? " panning" : ""}`}
        style={{
          backgroundPosition: `${v.x}px ${v.y}px`,
          backgroundSize: `${24 * v.zoom}px ${24 * v.zoom}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          const id = pressedItem.current;
          const it = id && board.items.find((i) => i.id === id);
          if (it) openViewer(it.fileId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const id = (e.target as HTMLElement).closest<HTMLElement>("[data-item]")?.dataset.item;
          if (!id) return;
          if (!selected.has(id)) setSelected(new Set([id]));
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div
          className="board-world"
          style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`, "--z": 1 / v.zoom } as React.CSSProperties}
        >
          {board.items.map((it) => (
            <BoardTile
              key={it.id}
              item={it}
              height={it.w * aspect(it.fileId)}
              selected={selected.has(it.id)}
              handles={single && selected.has(it.id)}
              full={it.w * v.zoom > THUMB_PX && meta.get(it.fileId)?.mediaType === "image"}
            />
          ))}
        </div>
        {board.items.length === 0 && (
          <div className="state-message board-empty">
            This board is empty. Select images in Search, Browse or Queue and press <kbd>B</kbd>, or right-click → Add to board.
          </div>
        )}
        <div className="board-toolbar" role="toolbar" aria-label="Board" onPointerDown={(e) => e.stopPropagation()}>
          {selected.size > 0 && (
            <>
              <button type="button" title="Flip horizontally (H)" aria-label="Flip horizontally" onClick={flipSelected}><Icon name="flip" /></button>
              <button type="button" title="Bring to front (])" onClick={toFront}>Front</button>
              <button type="button" title="Send to back ([)" onClick={toBack}>Back</button>
              <button type="button" className="danger" title="Remove from board (Del)" aria-label="Remove from board" onClick={removeSelected}><Icon name="close" /></button>
              <span className="sep" />
            </>
          )}
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
          <button type="button" title="Zoom to 100%" onClick={() => {
            const el = canvasRef.current;
            if (el) update((b) => ({ ...b, view: zoomAt(b.view, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, 1 / b.view.zoom, BOARD_ZOOM) }));
          }}>{Math.round(v.zoom * 100)}%</button>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
          <button type="button" title="Fit all (0)" onClick={() => update((b) => ({ ...b, view: fitAll(b) }))}>Fit</button>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} />}
      {viewerId && <Viewer fileId={viewerId} onClose={closeViewer} />}
    </>
  );
}

function BoardTile({ item, height, selected, handles, full }: {
  item: BoardItem;
  height: number;
  selected: boolean;
  handles: boolean;
  /** shown big enough on screen that the thumbnail would look soft */
  full: boolean;
}) {
  return (
    <div
      data-item={item.id}
      className={`board-item${selected ? " sel" : ""}`}
      style={{ left: item.x, top: item.y, width: item.w, height, transform: item.rot ? `rotate(${item.rot}deg)` : undefined }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={full ? `/api/file/${item.fileId}` : `/api/thumb/${item.fileId}`}
        alt=""
        draggable={false}
        style={item.flipX ? { transform: "scaleX(-1)" } : undefined}
      />
      {handles && (
        <>
          <div data-handle="resize" className="board-handle resize" aria-hidden="true" />
          <div data-handle="rotate" className="board-handle rotate" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
