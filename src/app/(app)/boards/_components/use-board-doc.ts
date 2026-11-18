"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "refr/trpc/react";
import type { Board } from "refr/lib/boards";

const SAVE_DEBOUNCE_MS = 600;
const HISTORY_LIMIT = 200;

/**
 * A board document with undo/redo and debounced autosave. The local copy is the
 * source of truth once loaded. View (pan/zoom) is NOT part of the document — it
 * never saves; the canvas keeps it per device.
 *
 * Edits go through `apply(fn, record)`. Continuous gestures call `begin()`, then
 * unrecorded `apply`s, then `end()`: one undo step per gesture (none if nothing
 * changed). `hidden` (suggestion decisions) is not undoable — undo/redo keep it.
 */
export function useBoardDoc(name: string) {
  const utils = api.useUtils();
  const q = api.boards.get.useQuery({ name }, { refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity });
  const save = api.boards.save.useMutation({
    meta: { customFeedback: true, silent: true },
    onSuccess: () => void utils.boards.list.invalidate(),
  });

  const [board, setBoard] = useState<Board | null>(null);
  const current = useRef<Board | null>(null);
  const past = useRef<Board[]>([]);
  const future = useRef<Board[]>([]);
  const gestureStart = useRef<Board | null>(null);
  const [, setHistoryVersion] = useState(0);
  const [unsaved, setUnsaved] = useState(false);

  // ---- autosave
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const saveMutate = save.mutate;
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!dirty.current || !current.current) return;
    dirty.current = false;
    setUnsaved(false);
    // ponytail: last-write-wins; renaming a board within the debounce window drops that edit
    saveMutate({ name, board: current.current });
  }, [name, saveMutate]);
  useEffect(() => () => flush(), [flush]);

  const commit = useCallback((next: Board) => {
    current.current = next;
    setBoard(next);
    dirty.current = true;
    setUnsaved(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush]);

  const pushPast = (b: Board) => {
    past.current.push(b);
    if (past.current.length > HISTORY_LIMIT) past.current.shift();
    future.current = [];
    setHistoryVersion((v) => v + 1);
  };

  useEffect(() => {
    if (q.data && !current.current) {
      current.current = q.data;
      setBoard(q.data);
    }
  }, [q.data]);

  const apply = useCallback((fn: (b: Board) => Board, record = true) => {
    const b = current.current;
    if (!b) return;
    const next = fn(b);
    if (next === b) return;
    if (record && !gestureStart.current) pushPast(b);
    commit(next);
  }, [commit]);

  const begin = useCallback(() => {
    gestureStart.current ??= current.current;
  }, []);
  const end = useCallback(() => {
    const start = gestureStart.current;
    gestureStart.current = null;
    if (start && start !== current.current) pushPast(start);
  }, []);
  /** Abandon the gesture: restore its starting state without an undo step. */
  const cancel = useCallback(() => {
    const start = gestureStart.current;
    gestureStart.current = null;
    if (start && start !== current.current) commit({ ...start, hidden: current.current!.hidden });
  }, [commit]);

  const undo = useCallback(() => {
    const b = current.current;
    const prev = past.current.pop();
    if (!b || !prev) return;
    gestureStart.current = null;
    future.current.push(b);
    setHistoryVersion((v) => v + 1);
    commit({ ...prev, hidden: b.hidden });
  }, [commit]);
  const redo = useCallback(() => {
    const b = current.current;
    const next = future.current.pop();
    if (!b || !next) return;
    gestureStart.current = null;
    past.current.push(b);
    setHistoryVersion((v) => v + 1);
    commit({ ...next, hidden: b.hidden });
  }, [commit]);

  return {
    query: q,
    board,
    /** latest document (for event handlers that run between renders) */
    current,
    apply,
    begin,
    end,
    cancel,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    saving: unsaved || save.isPending,
  };
}
