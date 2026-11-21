"use client";

import { useState } from "react";
import { api } from "refr/trpc/react";
import type { MenuItem } from "./context-menu";
import { ConfirmDialog, PromptDialog } from "./dialog";
import { FolderTree } from "./folder-tree";
import type { SavedNode, SavedSearchNode } from "refr/lib/saved-searches";

/**
 * Saved-search sidebar: a nested folder tree that is renamable, collapsible,
 * and reorderable/movable by native drag-and-drop. Server owns the tree.
 */
export function SavedSearches({
  nodes,
  onOpen,
  onEdit,
  editing,
  onRenamed,
}: {
  nodes: SavedNode[];
  onOpen: (s: SavedSearchNode) => void;
  /** load the search into the bar so saving overwrites it */
  onEdit?: (s: SavedSearchNode) => void;
  /** name of the search currently being edited (highlighted) */
  editing?: string | null;
  onRenamed?: (oldName: string, newName: string) => void;
}) {
  const utils = api.useUtils();
  const invalidate = () => void utils.searches.list.invalidate();
  const moveM = api.searches.move.useMutation({ onSuccess: invalidate });
  const createFolderM = api.searches.createFolder.useMutation({ onSuccess: invalidate });
  const renameFolderM = api.searches.renameFolder.useMutation({ onSuccess: invalidate });
  const deleteFolderM = api.searches.deleteFolder.useMutation({ onSuccess: invalidate });
  const renameM = api.searches.rename.useMutation({ onSuccess: invalidate });
  const deleteM = api.searches.delete.useMutation({ onSuccess: invalidate });

  const [renameOf, setRenameOf] = useState<string | null>(null);
  const [deleteOf, setDeleteOf] = useState<string | null>(null);

  const searchMenu = (s: SavedSearchNode): MenuItem[] => [
    ...(onEdit ? [{ label: "Edit search", onClick: () => onEdit(s) }] : []),
    { label: "Rename…", onClick: () => setRenameOf(s.name) },
    { label: "Delete…", onClick: () => setDeleteOf(s.name), danger: true },
  ];

  return (
    <>
      <FolderTree
        nodes={nodes}
        ops={{
          move: (v) => moveM.mutate(v),
          createFolder: (v) => createFolderM.mutate(v),
          renameFolder: (v) => renameFolderM.mutate(v),
          deleteFolder: (v) => deleteFolderM.mutate(v),
        }}
        onOpen={onOpen}
        leafMenu={searchMenu}
        isSelected={(s) => editing === s.name}
        empty={
          <p className="px-2 text-xs text-fg-subtle">
            No saved searches yet. Save a search or create a folder.
          </p>
        }
      />
      {renameOf !== null && (
        <PromptDialog
          title="Rename search"
          label="New name"
          initial={renameOf}
          onSubmit={(newName) => {
            const oldName = renameOf;
            renameM.mutate({ oldName, newName }, { onSuccess: () => onRenamed?.(oldName, newName) });
          }}
          onClose={() => setRenameOf(null)}
        />
      )}
      {deleteOf !== null && (
        <ConfirmDialog
          title="Delete saved search"
          body={<>Delete <b>{deleteOf}</b>?</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteM.mutate({ name: deleteOf })}
          onClose={() => setDeleteOf(null)}
        />
      )}
    </>
  );
}
