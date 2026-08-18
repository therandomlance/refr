"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "refr/trpc/react";
import { TagInput } from "refr/app/_components/tag-input";
import { SessionRunner } from "refr/app/_components/session-runner";
import type { HistoryEntry, SessionBlock } from "refr/server/services/sessions";

/** Session template editor (§11.4): tag | count | time | auto-scroll rows, drag to reorder. */
export default function SessionEditPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);
  const router = useRouter();
  const utils = api.useUtils();

  const template = api.sessions.get.useQuery({ name });
  const save = api.sessions.save.useMutation();
  const generate = api.sessions.generate.useMutation();

  const [blocks, setBlocks] = useState<SessionBlock[]>([]);
  const [dirty, setDirty] = useState(false);
  const [run, setRun] = useState<HistoryEntry | null>(null);
  const dragRow = useRef<number>(-1);

  useEffect(() => {
    if (template.data) setBlocks(template.data.blocks);
  }, [template.data]);

  const update = (i: number, patch: Partial<SessionBlock>) => {
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
    setDirty(true);
  };

  const doSave = async () => {
    await save.mutateAsync({ name, blocks });
    setDirty(false);
    void utils.sessions.get.invalidate({ name });
    void utils.sessions.list.invalidate();
  };

  const startRun = async () => {
    if (dirty) await doSave();
    const entry = await generate.mutateAsync({ name });
    setRun(entry);
  };

  if (template.isLoading) return <p className="p-6 text-sm" style={{ color: "var(--text-faint)" }}>Loading…</p>;
  if (!template.data) return <p className="p-6 text-sm">Template not found.</p>;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-6">
      <div className="mb-5 flex items-center gap-3">
        <button className="btn" onClick={() => router.push("/sessions")}>←</button>
        <h1 className="text-lg font-semibold">{name}</h1>
        <div className="ml-auto flex gap-2">
          <button className="btn" onClick={doSave} disabled={!dirty}>
            {dirty ? "Save" : "Saved"}
          </button>
          <button className="btn primary" onClick={() => void startRun()} disabled={blocks.length === 0}>
            Start session
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2" style={{ maxWidth: 760 }}>
        <div className="grid grid-cols-[1fr_90px_110px_120px_32px] gap-2 px-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
          <span>Tag</span><span>Images</span><span>Time (mm:ss)</span><span>Auto-scroll</span><span />
        </div>
        {blocks.map((b, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_90px_110px_120px_32px] items-center gap-2 rounded-lg p-2"
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
            <input
              className="input"
              type="number"
              min={1}
              value={b.count}
              onChange={(e) => update(i, { count: Math.max(1, Number(e.target.value) || 1) })}
            />
            <input
              className="input"
              placeholder="—"
              value={b.seconds ? `${Math.floor(b.seconds / 60)}:${String(b.seconds % 60).padStart(2, "0")}` : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return update(i, { seconds: null, autoScroll: false });
                const m = /^(?:(\d+):)?(\d{0,2})$/.exec(v);
                if (!m) return;
                update(i, { seconds: (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) || null });
              }}
            />
            <label className="flex items-center gap-2 text-xs" style={{ color: b.seconds ? "var(--text-dim)" : "var(--text-faint)" }}>
              <input
                type="checkbox"
                disabled={!b.seconds}
                checked={b.autoScroll}
                onChange={(e) => update(i, { autoScroll: e.target.checked })}
              />
              Auto-scroll
            </label>
            <button className="btn" style={{ padding: "4px 8px" }} onClick={() => { setBlocks((bs) => bs.filter((_, j) => j !== i)); setDirty(true); }}>
              ✕
            </button>
            <div className="col-span-5 -mt-1 pl-1 text-xs" style={{ color: "var(--text-faint)" }}>{b.tag}</div>
          </div>
        ))}
        <button
          className="btn mt-1"
          onClick={() => {
            setBlocks((bs) => [...bs, { tag: "", count: 10, seconds: null, autoScroll: false }]);
            setDirty(true);
          }}
        >
          + Add row
        </button>
      </div>

      {run && template.data && (
        <SessionRunner template={{ name, blocks }} entry={run} onClose={() => setRun(null)} />
      )}
    </div>
  );
}
