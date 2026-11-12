"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import type { HistoryEntry, SessionTemplate } from "refr/server/services/sessions";
import { Viewer } from "./viewer";
import { publishViewerList } from "./viewer-store";
import { isTypingTarget } from "refr/lib/keyboard";

type FlatItem = { fileId: string; blockIndex: number; seconds: number | null; autoScroll: boolean; tag: string };

type RunState = { index: number; done: boolean; remaining: number | null; flash: boolean; paused?: boolean };
type RunAction = { type: "tick" | "next" | "finish" | "replay" | "togglePause" }
  | { type: "navigate"; index: number }
  | { type: "snooze"; seconds: number };

export function sessionReducer(state: RunState, action: RunAction, items: readonly Pick<FlatItem, "seconds" | "autoScroll">[]): RunState {
  // pause survives navigation (stepping through images while paused stays paused); replay resets it
  const at = (index: number, paused = state.paused): RunState => ({ index, done: false, remaining: items[index]?.seconds ?? null, flash: false, ...(paused ? { paused } : {}) });
  const next = () => state.index >= items.length - 1 ? { ...state, done: true } : at(state.index + 1);
  switch (action.type) {
    case "navigate": {
      const index = Math.max(0, Math.min(items.length - 1, action.index));
      return index === state.index ? state : at(index);
    }
    case "next": return next();
    case "finish": return { ...state, done: true };
    case "replay": return at(0, false);
    case "togglePause": return state.paused ? { ...state, paused: false } : { ...state, paused: true };
    case "snooze": return { ...state, remaining: Math.max(0, state.remaining ?? 0) + action.seconds, flash: false };
    case "tick": {
      if (state.done || state.paused || state.remaining === null || state.remaining <= 0) return state;
      const remaining = state.remaining - 1;
      if (remaining === 0 && items[state.index]?.autoScroll) return next();
      return { ...state, remaining, flash: remaining === 0 };
    }
  }
}

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

  const [{ index, done, remaining, flash, paused }, dispatch] = useReducer(
    (state: RunState, action: RunAction) => sessionReducer(state, action, flat),
    { index: 0, done: false, remaining: flat[0]?.seconds ?? null, flash: false },
  );
  const startedAt = useRef(Date.now());

  const current = flat[index];

  useEffect(() => {
    publishViewerList({
      items: flat.map((f) => ({ id: f.fileId, mediaType: "image", width: null, height: null, duration: null, mtime: 0 })),
      loadMore: null,
      hasMore: false,
    });
  }, [flat]);

  const hasTimer = remaining !== null;
  useEffect(() => {
    if (!hasTimer || done || paused) return;
    const t = setInterval(() => dispatch({ type: "tick" }), 1000);
    return () => clearInterval(t);
  }, [hasTimer, done, index, paused]);

  // Space pauses, n skips, + snoozes 60s. ←/→ stay with the Viewer's own handler.
  useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault(); // don't scroll or re-press a focused button
        if (hasTimer) dispatch({ type: "togglePause" });
      } else if (e.key === "n") dispatch({ type: "next" });
      else if ((e.key === "+" || e.key === "=") && hasTimer) dispatch({ type: "snooze", seconds: 60 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done, hasTimer]);

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
            <button className="btn primary" onClick={() => { dispatch({ type: "replay" }); startedAt.current = Date.now(); }}>
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
      onNavigate={(i) => dispatch({ type: "navigate", index: i })}
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
                style={flash ? { animation: "flash 0.6s infinite alternate" } : paused ? { color: "var(--text-faint)" } : remaining <= 10 ? { color: "var(--danger)", fontWeight: 700 } : undefined}
              >
                ⏱ {Math.floor(Math.max(0, remaining) / 60)}:{String(Math.max(0, remaining) % 60).padStart(2, "0")}
              </span>
              <button className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} aria-pressed={!!paused} title="Pause / resume (Space)" onClick={() => dispatch({ type: "togglePause" })}>
                {paused ? "▶ Resume" : "⏸ Pause"}
              </button>
              {([30, 60, 300, 600] as const).map((s) => (
                <button key={s} className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} onClick={() => dispatch({ type: "snooze", seconds: s })}>
                  +{s >= 60 ? `${s / 60}m` : `${s}s`}
                </button>
              ))}
            </>
          )}
          <button className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} title="Skip (n)" onClick={() => dispatch({ type: "next" })}>Skip →</button>
          <button className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} onClick={() => dispatch({ type: "finish" })}>End</button>
        </div>
      }
    />
  );
}
