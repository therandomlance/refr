"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "refr/trpc/react";
import { MediaGrid } from "refr/app/_components/media-grid";
import { formatConfidence } from "refr/lib/tagging";
import { useReviewCommit } from "./use-review-commit";
import { tagLabel } from "./tag-review";

type State = "accept" | "reject" | "skip";
const NEXT: Record<State, State> = { accept: "reject", reject: "skip", skip: "accept" };

/** Newest files first, each with its top confident tags as chips (start ✓).
 *  Click a chip to cycle ✓ → ✕ → –; "Commit page" applies every loaded file. */
export function FileReview({ minConfidence }: { minConfidence: number }) {
  const q = api.tagging.byFile.useInfiniteQuery(
    { minConfidence, limit: 60 },
    { getNextPageParam: (p) => p.nextCursor, refetchOnWindowFocus: false },
  );
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const ids = useMemo(() => items.map((i) => i.fileId), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.fileId, i.tags])), [items]);

  // fileId → tag → state; missing = accept
  const [states, setStates] = useState<Map<string, Map<string, State>>>(new Map());
  useEffect(() => { setStates(new Map()); }, [minConfidence]);
  const stateOf = (fileId: string, tag: string): State => states.get(fileId)?.get(tag) ?? "accept";
  const cycle = (fileId: string, tag: string) => {
    setStates((prev) => {
      const next = new Map(prev);
      const row = new Map(prev.get(fileId));
      row.set(tag, NEXT[row.get(tag) ?? "accept"]);
      next.set(fileId, row);
      return next;
    });
  };

  const plan = useMemo(() => items.map((it) => ({
    fileId: it.fileId,
    accept: it.tags.filter((t) => (states.get(it.fileId)?.get(t.tag) ?? "accept") === "accept").map((t) => t.tag),
    deny: it.tags.filter((t) => states.get(it.fileId)?.get(t.tag) === "reject").map((t) => t.tag),
  })).filter((p) => p.accept.length || p.deny.length), [items, states]);
  const accepts = plan.reduce((n, p) => n + p.accept.length, 0);
  const rejects = plan.reduce((n, p) => n + p.deny.length, 0);

  const review = useReviewCommit();
  const commit = async () => {
    try {
      await review.commitFiles(plan);
    } catch {
      return;
    }
    setStates(new Map());
  };

  const [selection, setSelection] = useState<Set<string>>(new Set());
  return (
    <MediaGrid
      source={{ kind: "ids", ids }}
      selection={selection}
      onSelectionChange={setSelection}
      header={
        <p className="pb-3 pt-1 text-xs text-fg-subtle">
          Newest files with confident tag matches. Chips start as ✓ — click one to cycle ✓ → ✕ → –. Click an image to open it.
        </p>
      }
      emptyState={q.isLoading ? "Loading…" : `No files with tag matches above ${formatConfidence(minConfidence)}.`}
      toolbarActions={
        <>
          <span className="text-xs text-fg-muted tabular-nums">{items.length} files · ✓ {accepts} · ✕ {rejects}</span>
          {q.hasNextPage && (
            <button className="btn sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {q.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
          <button className="btn sm primary" disabled={review.isPending || plan.length === 0} onClick={() => void commit()}>
            Commit page
          </button>
        </>
      }
      tileActions={(f) => (
        <div className="review-badges">
          {(byId.get(f.id) ?? []).map((t) => {
            const s = stateOf(f.id, t.tag);
            return (
              <button
                key={t.tag}
                type="button"
                className={`review-badge ${s === "accept" ? "on" : s === "reject" ? "off" : "skip"}`}
                title={`${t.tag} — ${formatConfidence(t.confidence)} confidence (${s}). Click to change.`}
                onClick={(e) => { e.stopPropagation(); cycle(f.id, t.tag); }}
              >
                {tagLabel(t.tag)} {formatConfidence(t.confidence)}
              </button>
            );
          })}
        </div>
      )}
    />
  );
}
