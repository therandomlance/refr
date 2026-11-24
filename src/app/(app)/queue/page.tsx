"use client";

import { useState } from "react";
import { api } from "refr/trpc/react";
import { MediaGrid } from "refr/app/_components/media-grid";
import { SidePanel } from "refr/app/_components/side-panel";
import { useFileContextMenu } from "refr/app/_components/file-menu";
import { ContextMenu } from "refr/app/_components/context-menu";
import { ConfirmDialog, PromptDialog } from "refr/app/_components/dialog";
import { moveQueueItems } from "refr/lib/queue-order";
import { Icon } from "refr/app/_components/icon";
import { hasDocumentPip } from "refr/app/_components/popout";
import { useReferenceWindow } from "refr/app/_components/reference-window";

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
  // optimistic: reorders show immediately instead of snapping back until the refetch
  const setQueue = api.queue.set.useMutation({
    onMutate: async ({ fileIds }) => {
      await utils.queue.get.cancel();
      const prev = utils.queue.get.getData();
      utils.queue.get.setData(undefined, fileIds);
      return { prev };
    },
    onError: (_e, _v, ctx) => utils.queue.get.setData(undefined, ctx?.prev),
    onSettled: () => void utils.queue.get.invalidate(),
  });
  const clear = api.queue.clear.useMutation({ onSuccess: () => void utils.queue.get.invalidate() });
  const save = api.queue.save.useMutation({ onSuccess: () => void utils.queue.listSaved.invalidate() });
  const load = api.queue.load.useMutation({ onSuccess: () => void utils.queue.get.invalidate() });
  const deleteSaved = api.queue.deleteSaved.useMutation({ onSuccess: () => void utils.queue.listSaved.invalidate() });

  const ids = queue.data ?? [];
  const up = moveQueueItems(ids, selection, -1);
  const down = moveQueueItems(ids, selection, 1);
  // pop-out reference window: steps through the queue in order, starting at the
  // first selected image
  const reference = useReferenceWindow();
  const openPopout = () => reference.openImages(ids, ids.find((id) => selection.has(id)));

  const fileMenu = useFileContextMenu(selection, setSelection, {
    allIds: ids,
    onReorder: (next) => setQueue.mutate({ fileIds: next }),
  });

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel
        head={
          <h2 className="text-[13px] font-semibold">Queue</h2>
        }
      >
        <div className="flex gap-2 px-4 pb-3">
          <button className="btn flex-1" style={{ fontSize: 12 }} disabled={ids.length === 0} onClick={() => setSavePrompt(true)}>Save as…</button>
          <button className="btn flex-1" style={{ fontSize: 12 }} disabled={ids.length === 0} onClick={() => setClearConfirm(true)}>Clear</button>
        </div>
        <div className="label px-4 pt-2 pb-1">
          Saved queues
        </div>
        <div className="flex-1 px-2 pb-4">
          {(saved.data ?? []).map((name) => (
            <div
              key={name}
              className="trow"
              onContextMenu={(e) => {
                e.preventDefault();
                setSavedMenu({ name, x: e.clientX, y: e.clientY });
              }}
            >
              <button type="button" className="tree-select" onClick={() => (ids.length > 0 ? setLoadOf(name) : load.mutate({ name }))}>{name}</button>
              <button type="button" className="tree-actions" aria-label={`Actions for ${name}`} onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setSavedMenu({ name, x: r.left, y: r.bottom });
              }}><Icon name="more" /></button>
            </div>
          ))}
          {saved.data?.length === 0 && (
            <p className="px-2 text-xs text-fg-subtle">No saved queues.</p>
          )}
        </div>
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="page-header">
          <div><h1>Queue</h1><p>{ids.length} images</p></div>
          <button
            className="btn ml-auto"
            disabled={ids.length === 0}
            title={hasDocumentPip() ? "Open the queue in a window that stays on top of other apps" : "Open the queue in a separate window"}
            onClick={openPopout}
          >
            <Icon name="popout" size={16} /> Pop out
          </button>
        </header>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-fg-muted">
          <span>Select images to reorder. Drag or use:</span>
          <button className="btn" disabled={setQueue.isPending || up.every((id, i) => id === ids[i])} onClick={() => setQueue.mutate({ fileIds: up })}>↑ Move up</button>
          <button className="btn" disabled={setQueue.isPending || down.every((id, i) => id === ids[i])} onClick={() => setQueue.mutate({ fileIds: down })}>↓ Move down</button>
        </div>
        <MediaGrid
          source={{ kind: "ids", ids }}
          selection={selection}
          onSelectionChange={setSelection}
          onContextMenu={fileMenu.open}
          onFileKey={fileMenu.handleKey}
          onReorder={(next) => setQueue.mutate({ fileIds: next })}
            emptyState="Queue is empty. Open an image’s actions menu elsewhere to add it."
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
