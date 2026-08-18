"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "refr/trpc/react";
import { SessionRunner } from "refr/app/_components/session-runner";
import { ConfirmDialog, PromptDialog } from "refr/app/_components/dialog";
import { ContextMenu } from "refr/app/_components/context-menu";
import type { HistoryEntry, SessionTemplate } from "refr/server/services/sessions";

export default function SessionsPage() {
  const [newPrompt, setNewPrompt] = useState(false);
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [renameOf, setRenameOf] = useState<string | null>(null);
  const [deleteOf, setDeleteOf] = useState<string | null>(null);
  const [run, setRun] = useState<{ template: SessionTemplate; entry: HistoryEntry } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const utils = api.useUtils();
  const templates = api.sessions.list.useQuery();
  const save = api.sessions.save.useMutation({ onSuccess: () => void utils.sessions.list.invalidate() });
  const del = api.sessions.delete.useMutation({ onSuccess: () => void utils.sessions.list.invalidate() });
  const rename = api.sessions.renameTemplate.useMutation({ onSuccess: () => void utils.sessions.list.invalidate() });
  const generate = api.sessions.generate.useMutation();

  const startSession = async (name: string) => {
    const [template, entry] = await Promise.all([
      utils.sessions.get.fetch({ name }),
      generate.mutateAsync({ name }),
    ]);
    if (template) setRun({ template, entry });
  };

  const replay = async (name: string, historyIndex: number) => {
    const [template, entry] = await Promise.all([
      utils.sessions.get.fetch({ name }),
      utils.sessions.replay.fetch({ name, historyIndex }),
    ]);
    if (template) setRun({ template, entry });
  };

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <button className="btn primary" onClick={() => setNewPrompt(true)}>New session</button>
      </div>

      <div className="flex flex-col gap-3">
        {(templates.data ?? []).map((name) => (
          <SessionCard
            key={name}
            name={name}
            expanded={expanded === name}
            onToggle={() => setExpanded(expanded === name ? null : name)}
            onStart={() => void startSession(name)}
            onReplay={(i) => void replay(name, i)}
            onMenu={(x, y) => setMenu({ name, x, y })}
          />
        ))}
        {templates.data?.length === 0 && (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No session templates yet. Create one to start a randomized study session.
          </p>
        )}
      </div>

      {run && <SessionRunner template={run.template} entry={run.entry} onClose={() => setRun(null)} />}
      {newPrompt && (
        <PromptDialog
          title="New session"
          label="Template name"
          onSubmit={(name) => save.mutate({ name, blocks: [] })}
          onClose={() => setNewPrompt(false)}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename…", onClick: () => setRenameOf(menu.name) },
            { label: "Delete…", onClick: () => setDeleteOf(menu.name), danger: true },
          ]}
        />
      )}
      {renameOf && (
        <PromptDialog
          title="Rename session"
          label="New name"
          initial={renameOf}
          onSubmit={(v) => rename.mutate({ oldName: renameOf, newName: v })}
          onClose={() => setRenameOf(null)}
        />
      )}
      {deleteOf && (
        <ConfirmDialog
          title="Delete session"
          body={<>Delete <b>{deleteOf}</b> and its history?</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => del.mutate({ name: deleteOf })}
          onClose={() => setDeleteOf(null)}
        />
      )}
    </div>
  );
}

function SessionCard({
  name,
  expanded,
  onToggle,
  onStart,
  onReplay,
  onMenu,
}: {
  name: string;
  expanded: boolean;
  onToggle: () => void;
  onStart: () => void;
  onReplay: (historyIndex: number) => void;
  onMenu: (x: number, y: number) => void;
}) {
  const template = api.sessions.get.useQuery({ name });
  const history = api.sessions.history.useQuery({ name }, { enabled: expanded });

  return (
    <div className="rounded-lg" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
      <div
        className="flex items-center gap-3 px-4 py-3"
        onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      >
        <button className="text-sm font-semibold hover:underline" onClick={onToggle}>
          {expanded ? "▾" : "▸"} {name}
        </button>
        <span className="text-xs" style={{ color: "var(--text-faint)" }}>
          {template.data?.blocks.length ?? 0} blocks
        </span>
        <div className="ml-auto flex gap-2">
          <Link href={`/sessions/${encodeURIComponent(name)}`} className="btn" style={{ fontSize: 12 }}>Edit</Link>
          <button className="btn primary" style={{ fontSize: 12 }} onClick={onStart} disabled={!template.data?.blocks.length}>
            Start
          </button>
        </div>
      </div>
      {expanded && (
        <div className="px-4 pb-3" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="pt-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
            History
          </div>
          {(history.data ?? []).map((h, i) => (
            <div key={i} className="trow mt-1" onClick={() => onReplay(i)}>
              <span>{new Date(h.date).toLocaleString()}</span>
              <span className="count">{h.blocks.reduce((n, b) => n + b.fileIds.length, 0)} images</span>
            </div>
          ))}
          {history.data?.length === 0 && (
            <p className="py-2 text-xs" style={{ color: "var(--text-faint)" }}>No runs yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
