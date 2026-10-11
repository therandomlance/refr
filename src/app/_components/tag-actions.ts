"use client";

import { useEffect, useRef, useState } from "react";
import { api, type RouterInputs } from "refr/trpc/react";
import { useActionFeedback } from "./action-feedback";

type TagInput = RouterInputs["tags"]["setTags"];
type Callbacks = { onSuccess?: () => void; onUndo?: () => void };

// Keep review candidates stable across edits/invalidation; explicit refetch still works.
export const staticSuggestionOptions = { staleTime: "static" as const };

/** One undoable edit path for the viewer, bulk actions, and suggestions. */
export function useTagEdit() {
  const notify = useActionFeedback();
  const utils = api.useUtils();
  const edit = api.tags.setTags.useMutation({ meta: { customFeedback: true } });
  const undo = api.tags.undo.useMutation({ meta: { customFeedback: true } });
  const invalidate = () => {
    void utils.tags.invalidate();
    void utils.browse.tagTree.invalidate();
    void utils.files.invalidate();
    void utils.search.invalidate();
    void utils.ml.invalidate();
  };
  const mutateAsync = async (input: TagInput, callbacks: Callbacks = {}) => {
    const result = await edit.mutateAsync(input);
    invalidate();
    callbacks.onSuccess?.();
    notify({
      message: result.changes.length ? "Tags updated." : "Tags already up to date.",
      undo: result.changes.length ? async () => {
        await undo.mutateAsync({ changes: result.changes });
        invalidate();
        callbacks.onUndo?.();
      } : undefined,
    });
    return result;
  };
  return {
    isPending: edit.isPending || undo.isPending,
    mutateAsync,
    mutate: (input: TagInput, callbacks?: Callbacks) => { void mutateAsync(input, callbacks).catch(() => undefined); },
  };
}

/** Hide only persisted decisions; undo restores both persistence and the tile. */
export function useSuggestionActions(tag: string | null) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const pending = useRef(new Set<string>());
  const currentTag = useRef(tag);
  currentTag.current = tag;
  const notify = useActionFeedback();
  const edit = useTagEdit();
  const exclude = api.ml.excludeSuggestion.useMutation({ meta: { customFeedback: true } });
  const restore = api.ml.restoreSuggestion.useMutation({ meta: { customFeedback: true } });
  const utils = api.useUtils();
  useEffect(() => { setHiddenIds(new Set()); }, [tag]);

  const decide = async (id: string, accept: boolean) => {
    if (!tag) return;
    const key = `${tag}\0${id}`;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setPendingIds(new Set(pending.current));
    const unhide = () => {
      if (currentTag.current !== tag) return;
      setHiddenIds((previous) => { const next = new Set(previous); next.delete(id); return next; });
    };
    try {
      if (accept) {
        await edit.mutateAsync({ fileIds: [id], add: [tag], remove: [] }, { onUndo: unhide });
      } else {
        const result = await exclude.mutateAsync({ tag, fileId: id });
        notify({ message: "Suggestion excluded.", undo: result.alreadyExcluded ? undefined : async () => {
          await restore.mutateAsync({ tag, fileId: id });
          unhide();
          void utils.ml.invalidate();
          void utils.search.invalidate();
        } });
      }
      if (currentTag.current === tag) setHiddenIds((previous) => new Set(previous).add(id));
    } catch { /* mutation feedback reports failures; the tile stays visible */ }
    finally {
      pending.current.delete(key);
      setPendingIds(new Set(pending.current));
    }
  };
  return {
    hiddenIds,
    isPending: (id: string) => pendingIds.has(`${tag}\0${id}`),
    accept: (id: string) => { void decide(id, true); },
    deny: (id: string) => { void decide(id, false); },
  };
}
