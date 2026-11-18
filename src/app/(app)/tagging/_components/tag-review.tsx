"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "refr/trpc/react";
import { MediaGrid } from "refr/app/_components/media-grid";
import { Icon } from "refr/app/_components/icon";
import { isTypingTarget, overlayOpen } from "refr/lib/keyboard";
import { BATCH_SIZE, formatConfidence, tagLabel } from "refr/lib/tagging";
import { useReviewCommit } from "./use-review-commit";

type Decision = { kind: "accept" | "reject" | "skip" } | { kind: "reassign"; to: string };


const NEXT: Record<"accept" | "reject" | "skip", Decision["kind"]> = { accept: "reject", reject: "skip", skip: "accept" };

/** One tag's review batch: high-confidence candidates start as ✓ accept, flagged
 *  ones (look-alike sibling, near a rejected image, uncertain) start as – skip.
 *  Click a tile to cycle ✓ → ✕ → –; commit applies the whole batch. */
export function TagReview({
  tag,
  minConfidence,
  includeUncertain,
  setIncludeUncertain,
  onNext,
}: {
  tag: string;
  minConfidence: number;
  includeUncertain: boolean;
  setIncludeUncertain: (v: boolean) => void;
  onNext: () => void;
}) {
  // files skipped this session stay out of later batches for this tag
  const [skipped, setSkipped] = useState<string[]>([]);
  const batch = api.tagging.batch.useQuery(
    { tag, minConfidence, includeUncertain, exclude: skipped, size: BATCH_SIZE },
    {
      refetchOnWindowFocus: false,
      // empty while this tag retrains/re-sweeps → poll for the fresh batch
      refetchInterval: (q) => (q.state.data?.sweeping && q.state.data.candidates.length === 0 ? 3000 : false),
    },
  );
  const data = batch.data;
  const candidates = useMemo(() => data?.candidates ?? [], [data]);
  const byId = useMemo(() => new Map(candidates.map((c) => [c.fileId, c])), [candidates]);
  const ids = useMemo(() => candidates.map((c) => c.fileId), [candidates]);

  // keep the user's toggles for files still in the batch across refetches
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  useEffect(() => {
    setDecisions((prev) => new Map(candidates.map((c) => [c.fileId, prev.get(c.fileId) ?? { kind: c.defaultState }])));
  }, [candidates]);

  const cycle = useCallback((id: string) => {
    setDecisions((prev) => {
      const cur = prev.get(id);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(id, { kind: cur.kind === "reassign" ? "accept" : NEXT[cur.kind] } as Decision);
      return next;
    });
  }, []);
  const reassign = (id: string, to: string) => {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(id, prev.get(id)?.kind === "reassign" ? { kind: "skip" } : { kind: "reassign", to });
      return next;
    });
  };
  const setAll = (kind: "accept" | "reject" | "skip") => setDecisions(new Map(ids.map((id) => [id, { kind }])));

  const counts = useMemo(() => {
    const c = { accept: 0, reject: 0, skip: 0, reassign: 0 };
    for (const d of decisions.values()) c[d.kind]++;
    return c;
  }, [decisions]);

  const review = useReviewCommit();
  const commit = useCallback(async (thenNext: boolean) => {
    if (review.isPending || decisions.size === 0) return;
    const accept: string[] = [];
    const deny: string[] = [];
    const skip: string[] = [];
    const moves = new Map<string, string[]>();
    for (const [id, d] of decisions) {
      if (d.kind === "accept") accept.push(id);
      else if (d.kind === "reject") deny.push(id);
      else if (d.kind === "reassign") moves.set(d.to, [...(moves.get(d.to) ?? []), id]);
      else skip.push(id);
    }
    try {
      await review.commitTag({ tag, accept, deny, reassign: [...moves].map(([to, fileIds]) => ({ tag: to, fileIds })) });
    } catch {
      return; // mutation feedback reports the failure; decisions stay as they were
    }
    if (skip.length) setSkipped((prev) => [...prev, ...skip]);
    if (thenNext) onNext();
  }, [review, decisions, tag, onNext]);

  const latest = useRef({ commit, onNext });
  latest.current = { commit, onNext };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || overlayOpen()) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void latest.current.commit(e.shiftKey);
      } else if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        latest.current.onNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const exemplars = data?.exemplars ?? [];

  const header = (
    <div className="flex flex-col gap-3 pb-3 pt-1">
      <p className="text-xs text-fg-subtle">
        Click an image to cycle <b>✓ accept</b> → <b>✕ reject</b> → <b>– skip</b>. Rejections teach the classifier.
        {" "}<kbd>Ctrl</kbd>+<kbd>Enter</kbd> commits, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> commits and moves on,
        {" "}<kbd>N</kbd> skips to the next tag, <kbd>Enter</kbd> on a hovered image opens it.
      </p>
      {exemplars.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            Already tagged{exemplars.length > 1 ? ` · ${exemplars.length} styles` : ""}
          </div>
          <div className="exemplar-strip scroll-thin">
            {exemplars.map((group, i) => (
              <div key={i} className="exemplar-group" title={`Style ${i + 1}`}>
                {group.map((id) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={id} src={`/api/thumb/${id}`} alt="" loading="lazy" decoding="async" />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const toolbar = (
    <>
      <span className="text-xs text-fg-muted tabular-nums">
        ✓ {counts.accept} · ✕ {counts.reject} · – {counts.skip}{counts.reassign ? ` · → ${counts.reassign}` : ""}
      </span>
      <button className="btn sm" onClick={() => setAll("accept")} disabled={!ids.length}>All ✓</button>
      <button className="btn sm" onClick={() => setAll("reject")} disabled={!ids.length}>All ✕</button>
      <label className="flex items-center gap-1 text-xs text-fg-muted" title="Also show lower-confidence candidates (start as skip)">
        <input type="checkbox" checked={includeUncertain} onChange={(e) => setIncludeUncertain(e.target.checked)} />
        Uncertain
      </label>
      <button className="btn sm" onClick={onNext} title="Next tag (N)">Next tag</button>
      <button
        className="btn sm primary"
        disabled={review.isPending || decisions.size === 0}
        onClick={() => void commit(false)}
        title="Commit batch (Ctrl+Enter)"
      >
        Commit
      </button>
    </>
  );

  const empty = batch.isLoading
    ? "Loading…"
    : data?.sweeping
      ? "Retraining on your decisions — new suggestions will appear here shortly…"
      : (
        <div className="flex flex-col items-start gap-2">
          <span>Nothing left above {formatConfidence(minConfidence)} for <b>{tag}</b>.</span>
          <button className="btn sm" onClick={onNext}>Next tag</button>
        </div>
      );

  return (
    <MediaGrid
      source={{ kind: "ids", ids }}
      selection={selection}
      onSelectionChange={setSelection}
      onTilePick={cycle}
      tileClass={(f) => `review-${decisions.get(f.id)?.kind ?? "skip"}`}
      toolbarActions={toolbar}
      header={header}
      emptyState={empty}
      tileActions={(f) => {
        const c = byId.get(f.id);
        const d = decisions.get(f.id);
        if (!c || !d) return null;
        const label = { accept: "Accept", reject: "Reject", skip: "Skip", reassign: "Reassign" }[d.kind];
        return (
          <>
            <button
              type="button"
              className="review-state"
              aria-label={`${label} — click to change`}
              title={`${label} — click to change`}
              onClick={(e) => { e.stopPropagation(); cycle(f.id); }}
            >
              {d.kind === "accept" ? <Icon name="check" /> : d.kind === "reject" ? <Icon name="close" /> : d.kind === "reassign" ? "→" : "–"}
            </button>
            <div className="review-badges">
              <span className="review-badge" title={`Scores higher than ${formatConfidence(c.confidence)} of images already tagged ${tag}`}>
                {formatConfidence(c.confidence)}
              </span>
              {c.rival && (
                <button
                  type="button"
                  className={`review-badge warn ${d.kind === "reassign" ? "on" : ""}`}
                  title={c.rival.confidence >= 1
                    ? `Already tagged ${c.rival.tag}. Click to keep it there and reject it here.`
                    : `Looks more like ${c.rival.tag}. Click to tag it ${c.rival.tag} instead.`}
                  onClick={(e) => { e.stopPropagation(); reassign(f.id, c.rival!.tag); }}
                >
                  ≈ {tagLabel(c.rival.tag)}
                </button>
              )}
              {c.nearDenial && <span className="review-badge warn" title={`Very similar to an image you rejected for ${tag}`}>near rejected</span>}
              {c.uncertain && <span className="review-badge" title="Below the confidence threshold">uncertain</span>}
            </div>
          </>
        );
      }}
    />
  );
}
