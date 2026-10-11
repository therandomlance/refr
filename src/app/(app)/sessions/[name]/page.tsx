"use client";
import { Icon } from "refr/app/_components/icon";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "refr/trpc/react";
import { TagInput } from "refr/app/_components/tag-input";
import { SessionRunner } from "refr/app/_components/session-runner";
import type { HistoryEntry, SessionBlock } from "refr/server/services/sessions";
import { formatDurationInput, parseDuration } from "refr/lib/duration";
import { useActionFeedback } from "refr/app/_components/action-feedback";

type DraftBlock = SessionBlock & { time: string };

/** Session template editor (§11.4): tag | count | time | auto-scroll rows, drag to reorder. */
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
  const [dirty, setDirty] = useState(false);
  const [run, setRun] = useState<HistoryEntry | null>(null);
  const dragRow = useRef<number>(-1);

  useEffect(() => {
    if (template.data) setBlocks(template.data.blocks.map((b) => ({ ...b, time: formatDurationInput(b.seconds) })));
  }, [template.data]);

  const update = (i: number, patch: Partial<DraftBlock>) => {
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
    setDirty(true);
  };

  const doSave = async () => {
    if (blocks.some((b) => !b.tag.trim() || parseDuration(b.time) === undefined)) {
      notify({ message: "Choose a tag and enter a valid duration (mm:ss or seconds) for each row.", error: true });
      return false;
    }
    try {
      await save.mutateAsync({ name, blocks: blocks.map(({ time, ...b }) => {
        const seconds = parseDuration(time) ?? null;
        return { ...b, seconds, autoScroll: !!seconds && b.autoScroll };
      }) });
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

  if (template.isLoading) return <p className="p-6 text-sm" style={{ color: "var(--text-faint)" }}>Loading…</p>;
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

      <div className="flex flex-col gap-2" style={{ maxWidth: 760 }}>
        <p id="duration-help" className="text-xs" style={{ color: "var(--text-dim)" }}>Time: mm:ss or seconds; leave blank for an untimed block.</p>
        <div className="hidden sm:grid sm:grid-cols-[minmax(0,1fr)_90px_110px_120px_32px] gap-2 px-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>
          <span>Tag</span><span>Images</span><span>Time (mm:ss)</span><span>Auto-scroll</span><span />
        </div>
        {blocks.map((b, i) => (
          <div
            key={i}
            className="grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_90px_110px_120px_32px] items-center gap-2 rounded-lg p-2"
            style={{ background: "var(--panel)", border: "1px solid var(--border)" }}
            draggable
            onDragStart={() => (dragRow.current = i)}
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
            <TagInput
              placeholder="tag/path…"
              onCommit={(raw) => update(i, { tag: raw.replace(/^[-~=]+/, "") })}
            />
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
            <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs sm:hidden">Time (mm:ss)</span>
            <input
              className="input"
              aria-label={`Duration for block ${i + 1}`}
              aria-describedby="duration-help"
              aria-invalid={parseDuration(b.time) === undefined}
              placeholder="—"
              value={b.time}
              onChange={(e) => update(i, { time: e.target.value })}
            />
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-dim)" }}>
              <input
                type="checkbox"
                disabled={!parseDuration(b.time)}
                checked={b.autoScroll}
                onChange={(e) => update(i, { autoScroll: e.target.checked })}
              />
              Auto-scroll
            </label>
            <button className="btn" aria-label={`Remove block ${i + 1}`} style={{ padding: "4px 8px" }} onClick={() => { setBlocks((bs) => bs.filter((_, j) => j !== i)); setDirty(true); }}>
              <Icon name="close" />
            </button>
            <div className="col-span-2 sm:col-span-5 -mt-1 pl-1 text-xs" style={{ color: "var(--text-dim)" }}>{b.tag}</div>
          </div>
        ))}
        <button
          className="btn mt-1"
          onClick={() => {
            setBlocks((bs) => [...bs, { tag: "", count: 10, seconds: null, autoScroll: false, time: "" }]);
            setDirty(true);
          }}
        >
          + Add row
        </button>
      </div>

      {run && template.data && (
        <SessionRunner template={{ name, blocks: blocks.map(({ time, ...b }) => ({ ...b, seconds: parseDuration(time) ?? null })) }} entry={run} onClose={() => setRun(null)} />
      )}
    </div>
  );
}
