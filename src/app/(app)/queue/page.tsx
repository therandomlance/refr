"use client";

import { useState } from "react";
import { api } from "refr/trpc/react";
import { MediaGrid } from "refr/app/_components/media-grid";
import { SidePanel } from "refr/app/_components/side-panel";
import { useFileContextMenu } from "refr/app/_components/file-menu";
import { ContextMenu } from "refr/app/_components/context-menu";
import { ConfirmDialog, PromptDialog } from "refr/app/_components/dialog";

export default function QueuePage() {
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [savePrompt, setSavePrompt] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [loadOf, setLoadOf] = useState<string | null>(null);
  const [deleteOf, setDeleteOf] = useState<string | null>(null);
  const [savedMenu, setSavedMenu] = useState<{ name: string; x: number; y: number } | null>(null);

  const utils = api.useUtils();
  const queue = api.queue.get.useQuery();
  const saved = api.queue.listSaved.useQuery();
  const setQueue = api.queue.set.useMutation({ onSuccess: () => void utils.queue.get.invalidate() });
  const clear = api.queue.clear.useMutation({ onSuccess: () => void utils.queue.get.invalidate() });
  const save = api.queue.save.useMutation({ onSuccess: () => void utils.queue.listSaved.invalidate() });
  const load = api.queue.load.useMutation({ onSuccess: () => void utils.queue.get.invalidate() });
  const deleteSaved = api.queue.deleteSaved.useMutation({ onSuccess: () => void utils.queue.listSaved.invalidate() });

  const ids = queue.data ?? [];
  const fileMenu = useFileContextMenu(selection, setSelection, {
    allIds: ids,
    onReorder: (next) => setQueue.mutate({ fileIds: next }),
  });

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel
        head={
          <div>
            <h2 className="text-[13px] font-semibold">Queue</h2>
            <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>{ids.length} images</p>
          </div>
        }
      >
        <div className="flex gap-2 px-4 pb-3">
          <button className="btn flex-1" style={{ fontSize: 12 }} disabled={ids.length === 0} onClick={() => setSavePrompt(true)}>Save as…</button>
          <button className="btn flex-1" style={{ fontSize: 12 }} disabled={ids.length === 0} onClick={() => setClearConfirm(true)}>Clear</button>
        </div>
        <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
          Saved queues
        </div>
        <div className="flex-1 px-2 pb-4">
          {(saved.data ?? []).map((name) => (
            <div
              key={name}
              className="trow"
              onClick={() => (ids.length > 0 ? setLoadOf(name) : load.mutate({ name }))}
              onContextMenu={(e) => {
                e.preventDefault();
                setSavedMenu({ name, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="overflow-hidden text-ellipsis">{name}</span>
            </div>
          ))}
          {saved.data?.length === 0 && (
            <p className="px-2 text-xs" style={{ color: "var(--text-faint)" }}>No saved queues.</p>
          )}
        </div>
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        <MediaGrid
          source={{ kind: "ids", ids }}
          selection={selection}
          onSelectionChange={setSelection}
          onContextMenu={fileMenu.open}
          onReorder={(next) => setQueue.mutate({ fileIds: next })}
          emptyState="Queue is empty. Right-click images elsewhere to add them."
        />
      </main>

      {fileMenu.element}
      {savePrompt && (
        <PromptDialog
          title="Save queue"
          label="Queue name"
          onSubmit={(name) => save.mutate({ name })}
          onClose={() => setSavePrompt(false)}
        />
      )}
      {clearConfirm && (
        <ConfirmDialog
          title="Clear queue"
          body={<>Remove all {ids.length} images from the queue?</>}
          confirmLabel="Clear"
          danger
          onConfirm={() => clear.mutate()}
          onClose={() => setClearConfirm(false)}
        />
      )}
      {loadOf && (
        <ConfirmDialog
          title="Load queue"
          body={<>Replace the current queue ({ids.length} images) with <b>{loadOf}</b>?</>}
          confirmLabel="Load"
          onConfirm={() => load.mutate({ name: loadOf })}
          onClose={() => setLoadOf(null)}
        />
      )}
      {savedMenu && (
        <ContextMenu
          x={savedMenu.x}
          y={savedMenu.y}
          onClose={() => setSavedMenu(null)}
          items={[{ label: "Delete…", onClick: () => setDeleteOf(savedMenu.name), danger: true }]}
        />
      )}
      {deleteOf && (
        <ConfirmDialog
          title="Delete saved queue"
          body={<>Delete <b>{deleteOf}</b>?</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteSaved.mutate({ name: deleteOf })}
          onClose={() => setDeleteOf(null)}
        />
      )}
    </div>
  );
}
