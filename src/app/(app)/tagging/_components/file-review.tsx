"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "refr/trpc/react";
import { MediaGrid } from "refr/app/_components/media-grid";
import { Icon } from "refr/app/_components/icon";
import { formatConfidence } from "refr/lib/tagging";
import { useReviewCommit } from "./use-review-commit";
import { tagLabel } from "./tag-review";

/** Newest files first, each with its top confident tags as chips. Per tile, ✓
 *  accepts and ✕ rejects the included chips right away (undoable), like the other
 *  suggestion views. Click a chip to leave that tag out (it stays untouched).
 *  "Accept page" accepts the included chips of every file still shown. */
export function FileReview({ minConfidence }: { minConfidence: number }) {
  const q = api.tagging.byFile.useInfiniteQuery(
    { minConfidence, limit: 60 },
    { getNextPageParam: (p) => p.nextCursor, refetchOnWindowFocus: false },
  );
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const byId = useMemo(() => new Map(items.map((i) => [i.fileId, i.tags])), [items]);

  // fileId → tags left out of the ✓/✕ action
  const [excluded, setExcluded] = useState<Map<string, Set<string>>>(new Map());
  // decided this session; hidden until undo (the refetch drops them for good)
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  useEffect(() => {
    setExcluded(new Map());
    setHidden(new Set());
  }, [minConfidence]);

  const included = (fileId: string) => (byId.get(fileId) ?? []).filter((t) => !excluded.get(fileId)?.has(t.tag)).map((t) => t.tag);
  const toggleChip = (fileId: string, tag: string) => {
    setExcluded((prev) => {
      const next = new Map(prev);
      const set = new Set(prev.get(fileId));
      if (set.has(tag)) set.delete(tag);
      else set.add(tag);
      next.set(fileId, set);
      return next;
    });
  };

  const review = useReviewCommit();
  const decide = async (fileId: string, accept: boolean) => {
    const tags = included(fileId);
    if (!tags.length || pendingRef.current.has(fileId)) return;
    pendingRef.current.add(fileId);
    setPending(new Set(pendingRef.current));
    try {
      await review.commitFiles(
        [{ fileId, accept: accept ? tags : [], deny: accept ? [] : tags }],
        () => setHidden((prev) => { const next = new Set(prev); next.delete(fileId); return next; }),
      );
      setHidden((prev) => new Set(prev).add(fileId));
    } catch { /* mutation feedback reports it; the tile stays */ }
    finally {
      pendingRef.current.delete(fileId);
      setPending(new Set(pendingRef.current));
    }
  };

  const visible = useMemo(() => items.filter((i) => !hidden.has(i.fileId)), [items, hidden]);
  const ids = useMemo(() => visible.map((i) => i.fileId), [visible]);
  const acceptPage = async () => {
    const plan = visible.map((i) => ({ fileId: i.fileId, accept: included(i.fileId), deny: [] as string[] })).filter((p) => p.accept.length);
    if (!plan.length) return;
    const done = plan.map((p) => p.fileId);
    try {
      await review.commitFiles(plan, () => setHidden((prev) => { const next = new Set(prev); for (const id of done) next.delete(id); return next; }));
      setHidden((prev) => new Set([...prev, ...done]));
    } catch { /* reported by mutation feedback */ }
  };

  const [selection, setSelection] = useState<Set<string>>(new Set());
  return (
    <MediaGrid
      source={{ kind: "ids", ids }}
      selection={selection}
      onSelectionChange={setSelection}
      header={
        <p className="pb-3 pt-1 text-xs text-fg-subtle">
          Newest files with confident tag matches. <b>✓</b> adds the highlighted tags, <b>✕</b> rejects them — click a tag chip to leave it out.
          Click an image to open it.
        </p>
      }
      emptyState={q.isLoading ? "Loading…" : `No files with tag matches above ${formatConfidence(minConfidence)}.`}
      toolbarActions={
        <>
          <span className="text-xs text-fg-muted tabular-nums">{visible.length} files</span>
          {q.hasNextPage && (
            <button className="btn sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {q.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
          <button
            className="btn sm"
            disabled={review.isPending || visible.length === 0}
            onClick={() => void acceptPage()}
            title="Add the highlighted tags to every file shown"
          >
            Accept page
          </button>
        </>
      }
      tileActions={(f) => {
        const tags = byId.get(f.id) ?? [];
        const none = included(f.id).length === 0;
        const busy = pending.has(f.id);
        return (
          <>
            <button className="check review" title="Accept highlighted tags" aria-label="Accept highlighted tags" disabled={busy || none}
              onClick={(e) => { e.stopPropagation(); void decide(f.id, true); }}>
              <Icon name="check" />
            </button>
            <button className="deny review" title="Reject highlighted tags" aria-label="Reject highlighted tags" disabled={busy || none}
              onClick={(e) => { e.stopPropagation(); void decide(f.id, false); }}>
              <Icon name="close" />
            </button>
            <div className="review-badges">
              {tags.map((t) => {
                const on = !excluded.get(f.id)?.has(t.tag);
                return (
                  <button
                    key={t.tag}
                    type="button"
                    className={`review-badge ${on ? "on" : "skip"}`}
                    aria-pressed={on}
                    title={`${t.tag} — ${formatConfidence(t.confidence)} confidence. ${on ? "Click to leave it out." : "Click to include it."}`}
                    onClick={(e) => { e.stopPropagation(); toggleChip(f.id, t.tag); }}
                  >
                    {tagLabel(t.tag)} {formatConfidence(t.confidence)}
                  </button>
                );
              })}
            </div>
          </>
        );
      }}
    />
  );
}
