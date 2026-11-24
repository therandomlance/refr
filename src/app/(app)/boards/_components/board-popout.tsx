"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "refr/trpc/react";
import { StudyFilterDefs } from "refr/app/_components/study-image";
import { BOARD_ZOOM, resolveArrow, type Board, type BoardItem, type Box } from "refr/lib/boards";
import { zoomAt, type ZoomState } from "refr/lib/zoom";
import { ArrowShape, ImageTile, TextTile, THUMB_PX } from "./board-canvas";

const noop = () => undefined;

/**
 * Read-only board for the pop-out reference window: the same tiles as the
 * editor, fitted to the window, with wheel zoom, drag pan and double-click to
 * refit. Polls the saved board so edits in the main tab show up within seconds.
 */
export function BoardPopoutView({ name, win }: { name: string; win: Window }) {
  const q = api.boards.get.useQuery({ name }, { refetchInterval: 2000, refetchIntervalInBackground: true });
  const board: Board | undefined = q.data ?? undefined;

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

  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ZoomState | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || !board) return;
    const boxes = board.items.map(boxOf);
    if (boxes.length === 0) return setView({ x: el.clientWidth / 2, y: el.clientHeight / 2, zoom: 1 });
    const minX = Math.min(...boxes.map((r) => r.x));
    const minY = Math.min(...boxes.map((r) => r.y));
    const maxX = Math.max(...boxes.map((r) => r.x + r.w));
    const maxY = Math.max(...boxes.map((r) => r.y + r.h));
    const pad = 24;
    const z = Math.max(BOARD_ZOOM.min, Math.min(4, (el.clientWidth - pad * 2) / Math.max(1, maxX - minX), (el.clientHeight - pad * 2) / Math.max(1, maxY - minY)));
    setView({ zoom: z, x: (el.clientWidth - (maxX - minX) * z) / 2 - minX * z, y: (el.clientHeight - (maxY - minY) * z) / 2 - minY * z });
  }, [board, boxOf]);

  // frame the board once its geometry is known
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !board || (fileIds.length > 0 && !filesQ.data)) return;
    fitted.current = true;
    fit();
  }, [board, fileIds.length, filesQ.data, fit]);

  // refit when the window is resized, unless the user has zoomed/panned
  const userMoved = useRef(false);
  useEffect(() => {
    const onResize = () => { if (!userMoved.current) fit(); };
    win.addEventListener("resize", onResize);
    return () => win.removeEventListener("resize", onResize);
  }, [win, fit]);

  // native wheel listener: React's is passive
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved.current = true;
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      setView((v) => (v ? zoomAt(v, p, Math.exp(-dy * 0.0015), BOARD_ZOOM) : v));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") win.close();
      else if (e.key === "0" || e.key.toLowerCase() === "f") { userMoved.current = false; fit(); }
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [win, fit]);

  const drag = useRef<{ x: number; y: number; v: ZoomState } | null>(null);
  const lastMiddle = useRef<{ t: number; x: number; y: number } | null>(null);
  const boxes = useMemo(() => {
    const byId = new Map((board?.items ?? []).map((i) => [i.id, i]));
    return (id: string) => { const it = byId.get(id); return it ? boxOf(it) : null; };
  }, [board, boxOf]);

  const v = view;
  return createPortal(
    <div
      ref={ref}
      className="board-canvas"
      style={{ position: "fixed", inset: 0, ...(v ? { backgroundPosition: `${v.x}px ${v.y}px`, backgroundSize: `${24 * v.zoom}px ${24 * v.zoom}px` } : {}) }}
      onPointerDown={(e) => {
        // left or middle button drags (middle as in the editor); no middle-click autoscroll
        if (!v || (e.button !== 0 && e.button !== 1)) return;
        if (e.button === 1) {
          e.preventDefault();
          // dblclick only fires for the primary button: detect a middle double-click by hand
          const last = lastMiddle.current;
          lastMiddle.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
          if (last && e.timeStamp - last.t < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6) {
            lastMiddle.current = null;
            userMoved.current = false;
            fit();
            return;
          }
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, v };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        userMoved.current = true;
        setView({ ...d.v, x: d.v.x + e.clientX - d.x, y: d.v.y + e.clientY - d.y });
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => { userMoved.current = false; fit(); }}
      title="Scroll to zoom, drag (left or middle button) to pan, double-click to fit"
    >
      <StudyFilterDefs />
      {board && v && (
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
                selected={false}
                handles={false}
                full={it.w * v.zoom > THUMB_PX && meta.get(it.fileId)?.mediaType === "image"}
              />
            ) : (
              <TextTile key={it.id} item={it} selected={false} handles={false} editing={false} onText={noop} onDone={noop} />
            ),
          )}
          <svg className="board-arrows" aria-hidden="true">
            {board.arrows.map((a) => {
              const r = resolveArrow(a, boxes);
              return r ? <ArrowShape key={a.id} arrow={a} from={r.from} to={r.to} selected={false} /> : null;
            })}
          </svg>
        </div>
      )}
      {board?.items.length === 0 && <div className="state-message board-empty">This board is empty.</div>}
    </div>,
    win.document.body,
  );
}
