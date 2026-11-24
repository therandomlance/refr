"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { SidePanel } from "refr/app/_components/side-panel";
import type { MenuItem } from "refr/app/_components/context-menu";
import { FolderTree } from "refr/app/_components/folder-tree";
import { BoardCanvas } from "./_components/board-canvas";
import { useReferenceWindow } from "refr/app/_components/reference-window";
import { ConfirmDialog, PromptDialog } from "refr/app/_components/dialog";

export default function BoardsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const utils = api.useUtils();
  const reference = useReferenceWindow();
  const boards = api.boards.list.useQuery();
  const tree = api.boards.tree.useQuery();
  const [newPrompt, setNewPrompt] = useState(false);
  const [renameOf, setRenameOf] = useState<string | null>(null);
  const [deleteOf, setDeleteOf] = useState<string | null>(null);
  const [resetOf, setResetOf] = useState<{ name: string; count: number } | null>(null);
  // bumps when the open board's hidden list is reset, so its canvas clears its local copy too
  const [resetSignal, setResetSignal] = useState(0);

  const open = (name: string | null) =>
    router.replace(name ? `/boards?b=${encodeURIComponent(name)}` : "/boards");
  // default to the most recently changed board
  const requested = params.get("b");
  const current = requested ?? boards.data?.[0]?.name ?? null;

  const create = api.boards.create.useMutation({
    meta: { customFeedback: true },
    onSuccess: (name) => { void utils.boards.invalidate(); open(name); },
  });
  const rename = api.boards.rename.useMutation({
    meta: { customFeedback: true },
    onSuccess: (name, v) => {
      void utils.boards.invalidate();
      if (current === v.from) open(name);
    },
  });
  const resetHidden = api.boards.resetHidden.useMutation({
    meta: { customFeedback: true },
    onSuccess: (_r, v) => {
      void utils.boards.list.invalidate();
      if (current === v.name) setResetSignal((n) => n + 1);
    },
  });
  const remove = api.boards.delete.useMutation({
    meta: { customFeedback: true },
    onSuccess: (_r, v) => {
      void utils.boards.invalidate();
      if (current === v.name) open(null);
    },
  });

  const invalidateTree = () => void utils.boards.tree.invalidate();
  const moveM = api.boards.move.useMutation({ onSuccess: invalidateTree });
  const createFolderM = api.boards.createFolder.useMutation({ onSuccess: invalidateTree });
  const renameFolderM = api.boards.renameFolder.useMutation({ onSuccess: invalidateTree });
  const deleteFolderM = api.boards.deleteFolder.useMutation({ onSuccess: invalidateTree });

  const info = new Map((boards.data ?? []).map((b) => [b.name, b]));
  const boardMenu = (name: string): MenuItem[] => {
    const hidden = info.get(name)?.hidden ?? 0;
    return [
      { label: "Pop out", onClick: () => reference.openBoard(name) },
      { label: "Rename…", onClick: () => setRenameOf(name) },
      ...(hidden > 0 ? [{ label: `Reset hidden suggestions (${hidden})…`, onClick: () => setResetOf({ name, count: hidden }) }] : []),
      "sep" as const,
      { label: "Delete…", onClick: () => setDeleteOf(name), danger: true },
    ];
  };

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel
        head={
          <>
            <h2 className="text-[13px] font-semibold">Boards</h2>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => setNewPrompt(true)}>New</button>
          </>
        }
      >
        <FolderTree
          nodes={tree.data ?? []}
          ops={{
            move: (v) => moveM.mutate(v),
            createFolder: (v) => createFolderM.mutate(v),
            renameFolder: (v) => renameFolderM.mutate(v),
            deleteFolder: (v) => deleteFolderM.mutate(v),
          }}
          onOpen={(b) => open(b.name)}
          leafMenu={(b) => boardMenu(b.name)}
          isSelected={(b) => b.name === current}
          leafCount={(b) => info.get(b.name)?.count}
          empty={
            tree.data && (
              <p className="px-2 text-xs text-fg-subtle">No boards.</p>
            )
          }
        />
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <BoardCanvas key={current} name={current} resetHiddenSignal={resetSignal} />
        ) : (
          <>
            <header className="page-header"><div><h1>Boards</h1></div></header>
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
      {resetOf && (
        <ConfirmDialog
          title="Reset hidden suggestions"
          body={<>Show the {resetOf.count} hidden image{resetOf.count === 1 ? "" : "s"} in <b>{resetOf.name}</b>’s suggestions again?</>}
          confirmLabel="Reset"
          danger
          onConfirm={() => resetHidden.mutate({ name: resetOf.name })}
          onClose={() => setResetOf(null)}
        />
      )}
    </div>
  );
}
