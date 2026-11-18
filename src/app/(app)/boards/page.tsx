"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { SidePanel } from "refr/app/_components/side-panel";
import { ContextMenu } from "refr/app/_components/context-menu";
import { BoardCanvas } from "./_components/board-canvas";
import { ConfirmDialog, PromptDialog } from "refr/app/_components/dialog";
import { Icon } from "refr/app/_components/icon";

export default function BoardsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const utils = api.useUtils();
  const boards = api.boards.list.useQuery();
  const [newPrompt, setNewPrompt] = useState(false);
  const [renameOf, setRenameOf] = useState<string | null>(null);
  const [deleteOf, setDeleteOf] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);

  const open = (name: string | null) =>
    router.replace(name ? `/boards?b=${encodeURIComponent(name)}` : "/boards");
  // default to the most recently changed board
  const requested = params.get("b");
  const current = requested ?? boards.data?.[0]?.name ?? null;

  const create = api.boards.create.useMutation({
    meta: { customFeedback: true },
    onSuccess: (name) => { void utils.boards.list.invalidate(); open(name); },
  });
  const rename = api.boards.rename.useMutation({
    meta: { customFeedback: true },
    onSuccess: (name, v) => {
      void utils.boards.invalidate();
      if (current === v.from) open(name);
    },
  });
  const remove = api.boards.delete.useMutation({
    meta: { customFeedback: true },
    onSuccess: (_r, v) => {
      void utils.boards.list.invalidate();
      if (current === v.name) open(null);
    },
  });

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel
        head={
          <>
            <div>
              <h2 className="text-[13px] font-semibold">Boards</h2>
              <p className="mt-1 text-xs text-fg-subtle">{boards.data?.length ?? 0} boards</p>
            </div>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => setNewPrompt(true)}>New</button>
          </>
        }
      >
        <div className="flex-1 px-2 pb-4">
          {(boards.data ?? []).map((b) => (
            <div
              key={b.name}
              className={`trow ${b.name === current ? "sel" : ""}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ name: b.name, x: e.clientX, y: e.clientY });
              }}
            >
              <button type="button" className="tree-select" aria-current={b.name === current ? "page" : undefined} onClick={() => open(b.name)}>{b.name}</button>
              <span className="count">{b.count}</span>
              <button type="button" className="tree-actions" aria-label={`Actions for ${b.name}`} onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ name: b.name, x: r.left, y: r.bottom });
              }}><Icon name="more" /></button>
            </div>
          ))}
          {boards.data?.length === 0 && (
            <p className="px-2 text-xs text-fg-subtle">No boards yet. Create one, or select images in any grid and press B.</p>
          )}
        </div>
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <BoardCanvas key={current} name={current} />
        ) : (
          <>
            <header className="page-header"><div><h1>Boards</h1><p>Freeform reference boards.</p></div></header>
            <div className="state-message m-auto">
              {boards.isLoading ? "Loading…" : "Create a board, or select images in Search, Browse or Queue and press B."}
            </div>
          </>
        )}
      </main>

      {newPrompt && (
        <PromptDialog title="New board" label="Board name" onSubmit={(name) => create.mutate({ name })} onClose={() => setNewPrompt(false)} />
      )}
      {renameOf && (
        <PromptDialog
          title="Rename board"
          label="Board name"
          initial={renameOf}
          onSubmit={(to) => rename.mutate({ from: renameOf, to })}
          onClose={() => setRenameOf(null)}
        />
      )}
      {deleteOf && (
        <ConfirmDialog
          title="Delete board"
          body={<>Delete <b>{deleteOf}</b>? The images stay in your library.</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => remove.mutate({ name: deleteOf })}
          onClose={() => setDeleteOf(null)}
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
    </div>
  );
}
