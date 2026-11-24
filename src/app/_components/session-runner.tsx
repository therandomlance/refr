"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import type { HistoryEntry, SessionTemplate } from "refr/server/services/sessions";
import { Viewer } from "./viewer";
import { publishViewerList } from "./viewer-store";
import { FILE_SHORTCUTS, isTypingTarget } from "refr/lib/keyboard";
import { usePersistentBoolean } from "refr/lib/persistent-state";
import { api } from "refr/trpc/react";
import { useActionFeedback } from "./action-feedback";
import { Icon } from "./icon";
import { hasDocumentPip, PopoutView, usePopout } from "./popout";

type FlatItem = { kind: "image" | "break"; fileId: string; blockIndex: number; seconds: number | null; autoScroll: boolean; tag: string };

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

/** Short two-tone beep, no asset file. The context is created on first use
 *  (after the user's Start click, so autoplay rules allow it). */
let audio: AudioContext | null = null;
function chime() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const t = audio.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(t + i * 0.18);
      osc.stop(t + i * 0.18 + 0.4);
    }
  } catch {
    // no audio device / blocked: the flashing indicator still shows
  }
}

const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

/**
 * Session run mode (§11.4): fullscreen viewer + timer. Auto-scroll advances on
 * expiry; otherwise the indicator flashes (and a chime plays, if on). Snooze
 * adds time to the current image. Break blocks show a rest countdown. The run
 * can be mirrored into an always-on-top pop-out window (popout.tsx), and its
 * time and progress are recorded for the Sessions stats when it ends.
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
  const utils = api.useUtils();
  const notify = useActionFeedback();
  const flat: FlatItem[] = useMemo(
    () =>
      entry.blocks.flatMap((b, blockIndex): FlatItem[] => {
        // newer history entries carry their own timing; older ones look it up by tag
        const tpl = template.blocks.find((t) => t.tag === b.tag);
        const seconds = b.seconds !== undefined ? b.seconds : (tpl?.seconds ?? null);
        if (b.kind === "break") return [{ kind: "break", fileId: "", blockIndex, seconds, autoScroll: true, tag: b.tag }];
        const autoScroll = b.autoScroll ?? tpl?.autoScroll ?? false;
        return b.fileIds.map((fileId) => ({ kind: "image", fileId, blockIndex, seconds, autoScroll, tag: b.tag }));
      }),
    [entry, template],
  );
  // the viewer (and pop-out) only see images; breaks are run steps of their own
  const imageSteps = useMemo(() => flat.flatMap((f, i) => (f.kind === "image" ? [i] : [])), [flat]);
  const imageIds = useMemo(() => imageSteps.map((i) => flat[i]!.fileId), [imageSteps, flat]);

  const [state, dispatch] = useReducer(
    (s: RunState, action: RunAction) => sessionReducer(s, action, flat),
    { index: 0, done: false, remaining: flat[0]?.seconds ?? null, flash: false },
  );
  const { index, done, remaining, flash, paused } = state;
  const stateRef = useRef(state);
  stateRef.current = state;
  const startedAt = useRef(Date.now());
  const reached = useRef(0);
  reached.current = Math.max(reached.current, index);
  const recorded = useRef(false);
  const [chimeOn, setChimeOn] = usePersistentBoolean("refr:session-chime", () => true);
  const pop = usePopout("refr session");

  const current = flat[index];
  const isBreak = current?.kind === "break";
  // position in imageIds of the current image (during a break: the next one)
  const imagePos = Math.max(0, Math.min(imageIds.length - 1, imageSteps.findIndex((i) => i >= index)));
  const navigateImage = (pos: number) => dispatch({ type: "navigate", index: imageSteps[pos] ?? 0 });

  const finishM = api.sessions.finish.useMutation({
    meta: { silent: true, customFeedback: true },
    onSuccess: () => {
      void utils.sessions.stats.invalidate();
      void utils.sessions.history.invalidate();
    },
  });
  const record = () => {
    if (recorded.current) return;
    recorded.current = true;
    const viewed = imageSteps.filter((i) => i <= reached.current).length;
    finishM.mutate({
      name: template.name,
      date: entry.date,
      elapsedSeconds: Math.min(86_400, Math.round((Date.now() - startedAt.current) / 1000)),
      viewed,
    });
  };
  useEffect(() => {
    if (done) record();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  const close = () => {
    if (imageIds.length) record();
    onClose();
  };

  const queueQ = api.queue.get.useQuery();
  const setQueue = api.queue.set.useMutation({ meta: { customFeedback: true }, onSuccess: () => void utils.queue.get.invalidate() });
  const queueCurrent = () => {
    if (current?.kind !== "image") return;
    const ids = queueQ.data ?? [];
    if (ids.includes(current.fileId)) return notify({ message: "Already in the queue." });
    setQueue.mutate({ fileIds: [...ids, current.fileId] }, { onSuccess: () => notify({ message: "Added to the queue." }) });
  };

  useEffect(() => {
    publishViewerList({
      items: imageIds.map((id) => ({ id, mediaType: "image", width: null, height: null, duration: null, mtime: 0 })),
      loadMore: null,
      hasMore: false,
    });
  }, [imageIds]);

  const hasTimer = remaining !== null;
  useEffect(() => {
    if (!hasTimer || done || paused) return;
    const t = setInterval(() => {
      // this tick expires the timer (advance or flash)
      if (chimeOn && stateRef.current.remaining === 1) chime();
      dispatch({ type: "tick" });
    }, 1000);
    return () => clearInterval(t);
  }, [hasTimer, done, index, paused, chimeOn]);

  // Space pauses, n skips, + snoozes 60s, Q queues the image. ←/→ stay with the Viewer's own handler.
  const runKey = (e: KeyboardEvent): boolean => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === " ") {
      if (hasTimer) dispatch({ type: "togglePause" });
      return true;
    }
    if (e.key === "n") dispatch({ type: "next" });
    else if ((e.key === "+" || e.key === "=") && hasTimer) dispatch({ type: "snooze", seconds: 60 });
    else if (FILE_SHORTCUTS.queue.match(e)) queueCurrent();
    else return false;
    return true;
  };
  const runKeyRef = useRef(runKey);
  runKeyRef.current = runKey;
  useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      if (runKeyRef.current(e) && e.key === " ") e.preventDefault(); // don't scroll or re-press a focused button
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done]);

  if (imageIds.length === 0) {
    return (
      <div className="viewer" onClick={onClose}>
        <p className="m-auto text-fg-muted">This session pulled no images.</p>
      </div>
    );
  }

  if (done) {
    const minutes = Math.round((Date.now() - startedAt.current) / 60000);
    return (
      <div className="viewer" onClick={onClose}>
        <div className="m-auto flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-xl font-semibold">Session complete</h2>
          <div className="text-sm text-fg-muted">
            {entry.blocks.map((b, i) => (
              <div key={i} className="kv" style={{ minWidth: 260 }}>
                <span>{b.tag}</span>
                <b>{b.kind === "break" ? (b.seconds ? clock(b.seconds) : "break") : `${b.fileIds.length} images`}</b>
              </div>
            ))}
            <div className="kv" style={{ minWidth: 260 }}>
              <span>Total time</span>
              <b>~{minutes} min</b>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="btn primary"
              onClick={() => {
                dispatch({ type: "replay" });
                startedAt.current = Date.now();
                reached.current = 0;
                recorded.current = false;
              }}
            >
              Replay this session
            </button>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  const timerChip = remaining !== null && (
    <span
      className="chip"
      style={flash ? { animation: "flash 0.6s infinite alternate" } : paused ? { color: "var(--fg-subtle)" } : remaining <= 10 ? { color: "var(--danger)", fontWeight: 700 } : undefined}
    >
      ⏱ {clock(remaining)}
    </span>
  );
  const pauseChip = remaining !== null && (
    <button className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} aria-pressed={!!paused} title="Pause / resume (Space)" onClick={() => dispatch({ type: "togglePause" })}>
      {paused ? "▶ Resume" : "⏸ Pause"}
    </button>
  );
  const controls = (
    <>
      <span className="chip">{isBreak ? "Break" : current!.tag}</span>
      {!isBreak && <span className="chip">{imagePos + 1} / {imageIds.length}</span>}
      {timerChip}
      {remaining !== null && (
        <>
          {pauseChip}
          {([30, 60, 300, 600] as const).map((s) => (
            <button key={s} className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} onClick={() => dispatch({ type: "snooze", seconds: s })}>
              +{s >= 60 ? `${s / 60}m` : `${s}s`}
            </button>
          ))}
        </>
      )}
      <button className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} title="Skip (n)" onClick={() => dispatch({ type: "next" })}>Skip →</button>
      <button
        className="chip"
        style={{ cursor: "pointer", padding: "8px 14px" }}
        aria-pressed={chimeOn}
        title={chimeOn ? "Chime when time is up: on" : "Chime when time is up: off"}
        onClick={() => setChimeOn((v) => !v)}
      >
        {chimeOn ? "🔔" : "🔕"}
      </button>
      <button
        className="chip"
        style={{ cursor: "pointer", padding: "8px 14px" }}
        title={hasDocumentPip() ? "Show the image in a window that stays on top" : "Show the image in a separate window"}
        onClick={() => void (pop.win ? pop.close() : pop.open())}
      >
        <Icon name="popout" size={14} /> {pop.win ? "Close pop-out" : "Pop out"}
      </button>
      <button className="chip" style={{ cursor: "pointer", padding: "8px 14px" }} onClick={() => dispatch({ type: "finish" })}>End</button>
    </>
  );

  const popout = pop.win && (
    <PopoutView
      win={pop.win}
      ids={imageIds}
      index={imagePos}
      onIndex={navigateImage}
      onKey={(e) => runKey(e)}
      hud={<>{isBreak && <span className="chip">Break</span>}{timerChip}{pauseChip}</>}
    />
  );

  if (isBreak) {
    return (
      <div className="viewer">
        <div className="session-break">
          <span className="text-sm uppercase tracking-wide text-fg-muted">{current.tag}</span>
          {remaining !== null && <span className="timer" style={flash ? { animation: "flash 0.6s infinite alternate" } : undefined}>{clock(remaining)}</span>}
          <p className="text-sm text-fg-subtle">Stretch, rest your eyes. The next image is up when the break ends.</p>
          <div className="flex flex-wrap items-center justify-center gap-2">{controls}</div>
          <button className="btn ghost sm" onClick={close}>Close session</button>
        </div>
        {popout}
      </div>
    );
  }

  return (
    <>
      <Viewer
        fileId={current!.fileId}
        index={imagePos}
        onNavigate={navigateImage}
        onClose={close}
        overlayTop={
          <div
            className="absolute left-1/2 z-10 flex -translate-x-1/2 flex-wrap items-center justify-center gap-3 px-4"
            style={{ top: "max(1rem, env(safe-area-inset-top))" }}
            onClick={(e) => e.stopPropagation()}
          >
            {controls}
          </div>
        }
      />
      {popout}
    </>
  );
}
