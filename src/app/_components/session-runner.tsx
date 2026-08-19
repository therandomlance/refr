"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryEntry, SessionTemplate } from "refr/server/services/sessions";
import { Viewer } from "./viewer";
import { publishViewerList } from "./viewer-store";

type FlatItem = { fileId: string; blockIndex: number; seconds: number | null; autoScroll: boolean; tag: string };

/**
 * Session run mode (§11.4): fullscreen viewer + timer. Auto-scroll advances on
 * expiry; otherwise the indicator flashes. Snooze adds time to the current image.
 */
export function SessionRunner({
  template,
  entry,
  onClose,
}: {
  template: SessionTemplate;
  entry: HistoryEntry;
  onClose: () => void;
}) {
  const flat: FlatItem[] = useMemo(
    () =>
      entry.blocks.flatMap((b, blockIndex) => {
        const tpl = template.blocks.find((t) => t.tag === b.tag);
        return b.fileIds.map((fileId) => ({
          fileId,
          blockIndex,
          seconds: tpl?.seconds ?? null,
          autoScroll: tpl?.autoScroll ?? false,
          tag: b.tag,
        }));
      }),
    [entry, template],
  );

  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(flat[0]?.seconds ?? null);
  const [flash, setFlash] = useState(false);
  const startedAt = useRef(Date.now());

  const current = flat[index];

  useEffect(() => {
    publishViewerList({
      items: flat.map((f) => ({ id: f.fileId, mediaType: "image", width: null, height: null, duration: null, mtime: 0 })),
      loadMore: null,
      hasMore: false,
    });
  }, [flat]);

  // reset timer on image change
  useEffect(() => {
    setRemaining(current?.seconds ?? null);
    setFlash(false);
  }, [index, current?.seconds]);

  const hasTimer = remaining !== null;
  useEffect(() => {
    if (!hasTimer || done) return;
    const t = setInterval(() => setRemaining((r) => (r === null ? null : r - 1)), 1000);
    return () => clearInterval(t);
  }, [hasTimer, done]);

  const next = useCallback(() => {
    if (index >= flat.length - 1) setDone(true);
    else setIndex(index + 1);
  }, [index, flat.length]);

  // expiry
  useEffect(() => {
    if (remaining === null || remaining > 0) return;
    if (current?.autoScroll) next();
    else setFlash(true);
  }, [remaining, current?.autoScroll, next]);

  if (flat.length === 0) {
    return (
      <div className="viewer" onClick={onClose}>
        <p className="m-auto" style={{ color: "var(--text-dim)" }}>This session pulled no images.</p>
      </div>
    );
  }

  if (done) {
    const minutes = Math.round((Date.now() - startedAt.current) / 60000);
    return (
      <div className="viewer" onClick={onClose}>
        <div className="m-auto flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-xl font-semibold">Session complete</h2>
          <div className="text-sm" style={{ color: "var(--text-dim)" }}>
            {entry.blocks.map((b, i) => (
              <div key={i} className="kv" style={{ minWidth: 260 }}>
                <span>{b.tag}</span>
                <b>{b.fileIds.length} images</b>
              </div>
            ))}
            <div className="kv" style={{ minWidth: 260 }}>
              <span>Total time</span>
              <b>~{minutes} min</b>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn primary" onClick={() => { setIndex(0); setDone(false); startedAt.current = Date.now(); }}>
              Replay this session
            </button>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Viewer
      fileId={current!.fileId}
      index={index}
      onNavigate={(i) => setIndex(Math.max(0, Math.min(flat.length - 1, i)))}
      onClose={onClose}
      overlayTop={
        <div
          className="absolute left-1/2 z-10 flex -translate-x-1/2 flex-wrap items-center justify-center gap-3 px-4"
          style={{ top: "max(1rem, env(safe-area-inset-top))" }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="chip">{current!.tag}</span>
          <span className="chip">{index + 1} / {flat.length}</span>
          {remaining !== null && (
            <>
              <span
                className="chip"
                style={flash ? { animation: "flash 0.6s infinite alternate" } : remaining <= 10 ? { color: "#e66", fontWeight: 700 } : undefined}
              >
                ⏱ {Math.floor(Math.max(0, remaining) / 60)}:{String(Math.max(0, remaining) % 60).padStart(2, "0")}
              </span>
              {([30, 60, 300, 600] as const).map((s) => (
                <button key={s} className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} onClick={() => setRemaining((r) => (r ?? 0) + s)}>
                  +{s >= 60 ? `${s / 60}m` : `${s}s`}
                </button>
              ))}
            </>
          )}
          <button className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} onClick={next}>Skip →</button>
          <button className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} onClick={() => setDone(true)}>End</button>
        </div>
      }
    />
  );
}
