"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { SidePanel } from "refr/app/_components/side-panel";
import { usePersistentBoolean, usePersistentNumber } from "refr/lib/persistent-state";
import { DEFAULT_MIN_CONFIDENCE, formatConfidence } from "refr/lib/tagging";
import { TagReview } from "./_components/tag-review";
import { FileReview } from "./_components/file-review";
import { TagRulesEditor } from "./_components/tag-rules";
import { DuplicateReview } from "./_components/duplicate-review";

type View = "tags" | "files" | "rules" | "duplicates";

/** Tagging inbox: tags with confident untagged candidates from the background
 *  sweep (src/server/services/sweep.ts), reviewed a batch at a time. The Rules
 *  view edits tag aliases + implications and works without ML. */
export default function TaggingPage() {
  const router = useRouter();
  const params = useSearchParams();
  const viewParam = params.get("view");
  const view: View = viewParam === "files" || viewParam === "rules" || viewParam === "duplicates" ? viewParam : "tags";
  const tag = params.get("tag");

  const [minConfidence, setMinConfidence] = usePersistentNumber("refr:tagging:min-confidence", DEFAULT_MIN_CONFIDENCE, 0.3, 0.95);
  const [includeUncertain, setIncludeUncertain] = usePersistentBoolean("refr:tagging:uncertain", () => false);
  const [filter, setFilter] = useState("");

  const utils = api.useUtils();
  const mlStatus = api.ml.status.useQuery();
  const overview = api.tagging.overview.useQuery(
    { minConfidence },
    { refetchInterval: (q) => (q.state.data?.sweep.running || q.state.data?.sweep.pending ? 3000 : false) },
  );
  const resweep = api.tagging.resweep.useMutation({ onSuccess: () => void utils.tagging.overview.invalidate() });

  const tags = useMemo(() => {
    const all = overview.data?.tags ?? [];
    const f = filter.trim().toLowerCase();
    return all.filter((t) => (!f || t.tag.includes(f)) && (t.ready > 0 || t.flagged > 0 || (includeUncertain && t.uncertain > 0)));
  }, [overview.data, filter, includeUncertain]);
  const totalReady = tags.reduce((n, t) => n + t.ready, 0);

  const go = useCallback((next: { tag?: string | null; view?: View }) => {
    const p = new URLSearchParams();
    if (next.view && next.view !== "tags") p.set("view", next.view);
    else if (next.tag) p.set("tag", next.tag);
    router.push(p.size ? `/tagging?${p.toString()}` : "/tagging");
  }, [router]);

  const nextTag = useCallback(() => {
    const list = tags.filter((t) => t.tag !== tag);
    const i = tags.findIndex((t) => t.tag === tag);
    const after = i >= 0 ? tags.slice(i + 1).find((t) => t.ready > 0) : undefined;
    const pick = after ?? list.find((t) => t.ready > 0) ?? list[0];
    go({ tag: pick?.tag ?? null });
  }, [tags, tag, go]);

  const sweep = overview.data?.sweep;
  const sweepLine = sweep?.running
    ? sweep.progress ? `Scanning tags… ${sweep.progress.done}/${sweep.progress.total}` : "Scanning tags…"
    : sweep?.pending
      ? "Update queued…"
      : sweep?.lastFullAt
        ? `Last full scan ${new Date(sweep.lastFullAt).toLocaleString()}`
        : "Not scanned yet";

  const mlReady = mlStatus.data?.state === "ready";

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel
        head={
          <>
            <h2 className="text-[13px] font-semibold">Tagging</h2>
            <div className="seg">
              <button className={view === "tags" ? "on" : ""} onClick={() => go({ tag })}>Tags</button>
              <button className={view === "files" ? "on" : ""} onClick={() => go({ view: "files" })}>Files</button>
              <button className={view === "rules" ? "on" : ""} onClick={() => go({ view: "rules" })}>Rules</button>
              <button className={view === "duplicates" ? "on" : ""} onClick={() => go({ view: "duplicates" })}>Dupes</button>
            </div>
          </>
        }
      >
        <div className="flex flex-col gap-2 px-4 pb-3">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            <span className="flex justify-between">
              <span>Confidence</span>
              <b className="tabular-nums text-fg">≥ {formatConfidence(minConfidence)}</b>
            </span>
            <input
              type="range" min={0.3} max={0.95} step={0.05}
              value={minConfidence}
              onChange={(e) => setMinConfidence(Number(e.target.value))}
              aria-label="Minimum confidence"
            />
            <span className="text-[11px] text-fg-subtle">
              Share of a tag&apos;s own images a candidate must score above.
            </span>
          </label>
          <input className="input" placeholder="Filter tags…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
            <span className="min-w-0 truncate" title={sweep?.error ?? sweepLine}>{sweep?.error ? `Scan failed: ${sweep.error}` : sweepLine}</span>
            <button className="btn sm" disabled={!mlReady || !!sweep?.running || resweep.isPending} onClick={() => resweep.mutate()} title="Re-score every tag now">
              Rescan
            </button>
          </div>
        </div>
        <div className="px-4 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          {tags.length} tags · {totalReady} ready
        </div>
        <div className="flex-1 px-2 pb-4">
          {tags.map((t) => (
            <div key={t.tag} className={`trow ${view === "tags" && t.tag === tag ? "sel" : ""}`}>
              <button
                type="button"
                className="tree-select"
                title={`${t.tag}: ${t.ready} ready, ${t.flagged} flagged, ${t.uncertain} uncertain · best ${formatConfidence(t.top)} · ${t.positives} tagged`}
                onClick={() => go({ tag: t.tag })}
              >
                {t.tag}
              </button>
              <span className="count">{t.ready}{t.flagged ? ` +${t.flagged}` : ""}</span>
            </div>
          ))}
          {overview.data && tags.length === 0 && (
            <p className="px-2 text-xs text-fg-subtle">
              {sweep?.running || sweep?.pending ? "Scanning…" : "No confident suggestions right now. New images are picked up automatically."}
            </p>
          )}
        </div>
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="page-header">
          <div>
            <h1>{view === "duplicates" ? "Duplicates" : view === "rules" ? "Tag rules" : view === "files" ? "Tagging · new files" : (tag ?? "Tagging")}</h1>
            <p>
              {view === "duplicates"
                ? "Near-identical images. Keep one and its twin's tags merge onto it; the other is hidden, never deleted."
                : view === "rules"
                ? "Aliases and implications that keep your tags consistent."
                : view === "files"
                ? "Confident tag matches for your newest files."
                : tag
                  ? (() => {
                    const t = overview.data?.tags.find((x) => x.tag === tag);
                    return t ? `${t.ready} ready · ${t.flagged} flagged · ${t.positives} already tagged` : "Reviewing suggestions";
                  })()
                  : "Confident suggestions across all your tags, ready to review in batches."}
            </p>
          </div>
        </header>

        {view === "duplicates" ? (
          <DuplicateReview fileId={params.get("file")} />
        ) : view === "rules" ? (
          <TagRulesEditor />
        ) : !mlStatus.data ? null : !mlStatus.data.enabled ? (
          <div className="px-5 py-4 text-sm text-fg-muted">
            Tag suggestions need semantic features. Turn them on in <Link className="text-accent underline" href="/settings">Settings</Link>.
          </div>
        ) : view === "files" ? (
          <FileReview minConfidence={minConfidence} />
        ) : tag ? (
          <TagReview
            key={tag}
            tag={tag}
            minConfidence={minConfidence}
            includeUncertain={includeUncertain}
            setIncludeUncertain={setIncludeUncertain}
            onNext={nextTag}
          />
        ) : (
          <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
            {tags.length > 0 ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-fg-muted">
                  <b className="text-fg">{totalReady}</b> confident suggestions across <b className="text-fg">{tags.length}</b> tags.
                </p>
                <button className="btn primary" onClick={() => go({ tag: tags[0]!.tag })}>Start with {tags[0]!.tag}</button>
                <button className="btn" onClick={() => go({ view: "files" })}>Review newest files instead</button>
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">
                {sweep?.running || sweep?.pending || !mlReady
                  ? "Scanning your library for confident suggestions…"
                  : "Nothing to review — every tag is caught up at this confidence. Lower the threshold to see more."}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
