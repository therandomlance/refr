"use client";
import { Icon } from "refr/app/_components/icon";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "refr/trpc/react";
import { TokenField } from "refr/app/_components/token-field";
import { SessionRunner } from "refr/app/_components/session-runner";
import type { HistoryEntry, SessionBlock } from "refr/server/services/sessions";
import { makeToken, serializeQuery, type Token } from "refr/server/services/search";
import { formatDurationInput, parseDuration } from "refr/lib/duration";
import { useActionFeedback } from "refr/app/_components/action-feedback";

type DraftBlock = { kind: "images" | "break"; label: string; tokens: Token[]; count: number; time: string; autoScroll: boolean };

const toDraft = (b: SessionBlock): DraftBlock => ({
  kind: b.kind,
  label: b.kind === "break" ? b.tag : "",
  // legacy blocks carry only a tag: read it as one plain chip
  tokens: b.tokens?.length ? b.tokens : b.kind === "images" && b.tag.trim() ? [makeToken({ tag: b.tag.trim() })] : [],
  count: b.count,
  time: formatDurationInput(b.seconds),
  autoScroll: b.autoScroll,
});

const fromDraft = (b: DraftBlock): SessionBlock => {
  const seconds = parseDuration(b.time) ?? null;
  return b.kind === "break"
    ? { kind: "break", tag: b.label.trim() || "Break", count: 1, seconds, autoScroll: true }
    : { kind: "images", tag: serializeQuery(b.tokens), tokens: b.tokens, count: b.count, seconds, autoScroll: !!seconds && b.autoScroll };
};

/** Session template editor (§11.4): search | count | time | auto-scroll rows plus
 *  timed breaks, drag to reorder. */
export default function SessionEditPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);
  const router = useRouter();
  const utils = api.useUtils();
  const notify = useActionFeedback();

  const template = api.sessions.get.useQuery({ name });
  const save = api.sessions.save.useMutation();
  const generate = api.sessions.generate.useMutation();

  const [blocks, setBlocks] = useState<DraftBlock[]>([]);
  const [avoidRecent, setAvoidRecent] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [run, setRun] = useState<HistoryEntry | null>(null);
  const dragRow = useRef<number>(-1);

  useEffect(() => {
    if (!template.data) return;
    setBlocks(template.data.blocks.map(toDraft));
    setAvoidRecent(template.data.avoidRecent);
  }, [template.data]);

  const update = (i: number, patch: Partial<DraftBlock>) => {
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
    setDirty(true);
  };

  const doSave = async () => {
    const invalid = blocks.some((b) =>
      parseDuration(b.time) === undefined || (b.kind === "break" ? !parseDuration(b.time) : b.tokens.length === 0));
    if (invalid) {
      notify({ message: "Give every image row a search and every break a duration (mm:ss or seconds).", error: true });
      return false;
    }
    try {
      await save.mutateAsync({ name, blocks: blocks.map(fromDraft), avoidRecent });
      setDirty(false);
      void utils.sessions.get.invalidate({ name });
      void utils.sessions.list.invalidate();
      return true;
    } catch {
      return false; // mutation feedback reports the error; keep the draft
    }
  };

  const startRun = async () => {
    if (dirty && !(await doSave())) return;
    try {
      const entry = await generate.mutateAsync({ name });
      setRun(entry);
    } catch { /* mutation feedback reports the error */ }
  };

  if (template.isLoading) return <p className="p-6 text-sm text-fg-subtle">Loading…</p>;
  if (!template.data) return <p className="p-6 text-sm">Template not found.</p>;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-6">
      <header className="page-header page-header-inset">
        <div className="flex items-center gap-3">
          <button className="btn" aria-label="Back to sessions" onClick={() => router.push("/sessions")}><Icon name="left" /></button>
          <div><h1>{name}</h1><p>{blocks.length} study blocks</p></div>
        </div>
        <div className="ml-auto flex gap-2">
          <button className="btn" onClick={() => void doSave()} disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
          <button className="btn primary" onClick={() => void startRun()} disabled={blocks.length === 0 || save.isPending || generate.isPending}>
            {generate.isPending ? "Starting…" : "Start session"}
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-2" style={{ maxWidth: 860 }}>
        <p id="duration-help" className="text-xs text-fg-muted">
          Each row draws random images from a search, like the search bar: tags, -exclude, ~or, keywords such as fav or orient:portrait. Time: mm:ss or seconds; leave blank for an untimed block.
        </p>
        <div className="hidden sm:grid sm:grid-cols-[minmax(0,1fr)_90px_110px_120px_32px] gap-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          <span>Search</span><span>Images</span><span>Time (mm:ss)</span><span>Auto-scroll</span><span />
        </div>
        {blocks.map((b, i) => (
          <div
            key={i}
            className={`grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_90px_110px_120px_32px] items-center gap-2 rounded-lg p-2 card ${b.kind === "break" ? "border-dashed" : ""}`}
            draggable
            onDragStart={(e) => {
              // dragging from inside a text field selects text instead
              if ((e.target as HTMLElement).closest("input")) { e.preventDefault(); return; }
              dragRow.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              const from = dragRow.current;
              dragRow.current = -1;
              if (from === i || from < 0) return;
              setBlocks((bs) => {
                const next = [...bs];
                next.splice(i, 0, ...next.splice(from, 1));
                return next;
              });
              setDirty(true);
            }}
          >
            {b.kind === "break" ? (
              <input
                className="input col-span-2 sm:col-span-1"
                aria-label={`Label for break ${i + 1}`}
                placeholder="Break"
                value={b.label}
                onChange={(e) => update(i, { label: e.target.value })}
              />
            ) : (
              <div className="col-span-2 sm:col-span-1">
                <TokenField label={`Search for block ${i + 1}`} tokens={b.tokens} onChange={(tokens) => update(i, { tokens })} />
              </div>
            )}
            {b.kind === "break" ? (
              <span className="text-xs text-fg-subtle">Rest</span>
            ) : (
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-xs sm:hidden">Images</span>
                <input
                  className="input"
                  aria-label={`Images in block ${i + 1}`}
                  type="number"
                  min={1}
                  value={b.count}
                  onChange={(e) => update(i, { count: Math.max(1, Number(e.target.value) || 1) })}
                />
              </label>
            )}
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs sm:hidden">Time (mm:ss)</span>
              <input
                className="input"
                aria-label={`Duration for block ${i + 1}`}
                aria-describedby="duration-help"
                aria-invalid={parseDuration(b.time) === undefined || (b.kind === "break" && !parseDuration(b.time))}
                placeholder={b.kind === "break" ? "2:00" : "—"}
                value={b.time}
                onChange={(e) => update(i, { time: e.target.value })}
              />
            </label>
            {b.kind === "break" ? (
              <span className="text-xs text-fg-subtle">Continues when done</span>
            ) : (
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  disabled={!parseDuration(b.time)}
                  checked={b.autoScroll}
                  onChange={(e) => update(i, { autoScroll: e.target.checked })}
                />
                Auto-scroll
              </label>
            )}
            <button className="btn" aria-label={`Remove block ${i + 1}`} style={{ padding: "4px 8px" }} onClick={() => { setBlocks((bs) => bs.filter((_, j) => j !== i)); setDirty(true); }}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        <div className="mt-1 flex gap-2">
          <button
            className="btn flex-1"
            onClick={() => {
              setBlocks((bs) => [...bs, { kind: "images", label: "", tokens: [], count: 10, time: "", autoScroll: false }]);
              setDirty(true);
            }}
          >
            + Add row
          </button>
          <button
            className="btn"
            onClick={() => {
              setBlocks((bs) => [...bs, { kind: "break", label: "", tokens: [], count: 1, time: "2:00", autoScroll: true }]);
              setDirty(true);
            }}
          >
            + Add break
          </button>
        </div>
        <label className="mt-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          Skip images used in the last
          <input
            className="input w-20"
            type="number"
            min={0}
            max={1000}
            aria-label="Number of recent runs to avoid repeating"
            value={avoidRecent}
            onChange={(e) => { setAvoidRecent(Math.max(0, Math.min(1000, Number(e.target.value) || 0))); setDirty(true); }}
          />
          runs <span className="text-xs text-fg-subtle">(0 = off; repeats are used if a search runs out)</span>
        </label>
      </div>

      {run && template.data && (
        <SessionRunner template={{ name, blocks: blocks.map(fromDraft), avoidRecent }} entry={run} onClose={() => setRun(null)} />
      )}
    </div>
  );
}
