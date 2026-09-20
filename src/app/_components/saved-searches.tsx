"use client";

import { useState } from "react";
import { api } from "refr/trpc/react";
import { ContextMenu, type MenuItem } from "./context-menu";
import { ConfirmDialog, PromptDialog } from "./dialog";
import { nodeKeyAt, type SavedNode, type SavedSearchNode } from "refr/lib/saved-searches";

type Prompt =
  | { kind: "newFolder"; parent: string | null }
  | { kind: "renameFolder"; path: string; name: string }
  | { kind: "renameSearch"; name: string };

/**
 * Saved-search sidebar: a nested folder tree that is renamable, collapsible,
 * and reorderable/movable by native drag-and-drop. Server owns the tree.
 */
export function SavedSearches({
  nodes,
  onOpen,
}: {
  nodes: SavedNode[];
  onOpen: (s: SavedSearchNode) => void;
}) {
  const utils = api.useUtils();
  const invalidate = () => void utils.searches.list.invalidate();
  const moveM = api.searches.move.useMutation({ onSuccess: invalidate });
  const createFolderM = api.searches.createFolder.useMutation({ onSuccess: invalidate });
  const renameFolderM = api.searches.renameFolder.useMutation({ onSuccess: invalidate });
  const deleteFolderM = api.searches.deleteFolder.useMutation({ onSuccess: invalidate });
  const renameM = api.searches.rename.useMutation({ onSuccess: invalidate });
  const deleteM = api.searches.delete.useMutation({ onSuccess: invalidate });

  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggleFolder = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "folder" | "search"; ref: string } | null>(null);

  // -------- drag state
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ parent: string | null; beforeKey: string | null } | null>(null);

  const resetDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  const drop = () => {
    if (dragging && dropAt) moveM.mutate({ key: dragging, parent: dropAt.parent, beforeKey: dropAt.beforeKey });
    resetDrag();
  };
  // rows stop propagation so the container's onDrop (empty-space → root) doesn't double-fire
  const dropRow = (e: React.DragEvent) => {
    e.stopPropagation();
    drop();
  };
  const dragStart = (key: string) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key);
    setDragging(key);
  };
  // top/bottom edge of a row → insert before/after it (within its own parent)
  const edgeDrop = (parent: string | null, key: string, nextKey: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragging || dragging === key) return;
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    setDropAt({ parent, beforeKey: before ? key : nextKey });
  };
  const dropStyle = (parent: string | null, key: string, nextKey: string | null) => {
    if (!dragging || dropAt?.parent !== parent) return undefined;
    if (dropAt.beforeKey === key) return { boxShadow: "inset 0 2px 0 var(--accent)" };
    if (dropAt.beforeKey === null && nextKey === null) return { boxShadow: "inset 0 -2px 0 var(--accent)" };
    return undefined;
  };
  const insideStyle = (path: string) =>
    dragging && dropAt?.parent === path && dropAt.beforeKey === null
      ? { background: "var(--active)", outline: "1px solid var(--accent)" }
      : undefined;

  const searchMenu = (s: SavedSearchNode): MenuItem[] => [
    { label: "Rename…", onClick: () => setPrompt({ kind: "renameSearch", name: s.name }) },
    { label: "Delete…", onClick: () => setConfirmDelete({ kind: "search", ref: s.name }), danger: true },
  ];
  const folderMenu = (path: string): MenuItem[] => [
    { label: "New folder…", onClick: () => setPrompt({ kind: "newFolder", parent: path }) },
    { label: "Rename…", onClick: () => setPrompt({ kind: "renameFolder", path, name: path.split("/").pop()! }) },
    { label: "Delete…", onClick: () => setConfirmDelete({ kind: "folder", ref: path }), danger: true },
  ];

  const renderNodes = (items: SavedNode[], parent: string | null): React.ReactNode[] =>
    items.map((n, i) => {
      const key = nodeKeyAt(n, parent);
      const next = items[i + 1] ? nodeKeyAt(items[i + 1]!, parent) : null;
      if (n.t === "search") {
        return (
          <div
            key={key}
            className="trow"
            draggable
            onDragStart={dragStart(key)}
            onDragEnd={resetDrag}
            onDragOver={edgeDrop(parent, key, next)}
            onDrop={dropRow}
            style={dropStyle(parent, key, next)}
            onClick={() => onOpen(n)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, items: searchMenu(n) });
            }}
          >
            <span className="caret" />
            <span className="overflow-hidden text-ellipsis">{n.name}</span>
          </div>
        );
      }
      const path = parent ? `${parent}/${n.name}` : n.name;
      const open = !closed.has(path);
      return (
        <div key={key}>
          <div
            className="trow"
            draggable
            onDragStart={dragStart(key)}
            onDragEnd={resetDrag}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragging) return;
              const r = e.currentTarget.getBoundingClientRect();
              const rel = (e.clientY - r.top) / r.height;
              // middle band → drop inside the folder; edges → reorder at this level
              if (rel > 0.3 && rel < 0.7) setDropAt({ parent: path, beforeKey: null });
              else setDropAt({ parent, beforeKey: rel <= 0.3 ? key : next });
            }}
            onDrop={dropRow}
            style={{ ...dropStyle(parent, key, next), ...insideStyle(path) }}
            onClick={() => toggleFolder(path)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, items: folderMenu(path) });
            }}
          >
            <span className="caret">{open ? "▾" : "▸"}</span>
            <span className="overflow-hidden text-ellipsis">{n.name}</span>
            <span className="count">{n.children.length}</span>
          </div>
          {open && (
            <div className="tkids">
              {n.children.length > 0
                ? renderNodes(n.children, path)
                : (
                  <div
                    className="trow"
                    style={{ color: "var(--text-faint)", fontSize: 12 }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragging) setDropAt({ parent: path, beforeKey: null });
                    }}
                    onDrop={dropRow}
                  >
                    Drop here
                  </div>
                )}
            </div>
          )}
        </div>
      );
    });

  return (
    <div
      className="flex-1 px-2 pb-4"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items: [{ label: "New folder", onClick: () => setPrompt({ kind: "newFolder", parent: null }) }] });
      }}
      onDragOver={(e) => {
        // empty space (not a row) → append to root
        if (e.target === e.currentTarget) {
          e.preventDefault();
          setDropAt({ parent: null, beforeKey: null });
        }
      }}
      onDrop={drop}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDropAt(null);
      }}
    >
      {renderNodes(nodes, null)}
      {nodes.length === 0 && (
        <p className="px-2 text-xs" style={{ color: "var(--text-faint)" }}>
          No saved searches yet. Right-click for a folder.
        </p>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {prompt?.kind === "newFolder" && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          onSubmit={(name) => createFolderM.mutate({ name, parent: prompt.parent })}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === "renameFolder" && (
        <PromptDialog
          title="Rename folder"
          label="New name"
          initial={prompt.name}
          onSubmit={(newName) => renameFolderM.mutate({ path: prompt.path, newName })}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === "renameSearch" && (
        <PromptDialog
          title="Rename search"
          label="New name"
          initial={prompt.name}
          onSubmit={(newName) => renameM.mutate({ oldName: prompt.name, newName })}
          onClose={() => setPrompt(null)}
        />
      )}
      {confirmDelete?.kind === "folder" && (
        <ConfirmDialog
          title="Delete folder"
          body={<>Delete <b>{confirmDelete.ref}</b>? Contents move up to the parent folder.</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteFolderM.mutate({ path: confirmDelete.ref })}
          onClose={() => setConfirmDelete(null)}
        />
      )}
      {confirmDelete?.kind === "search" && (
        <ConfirmDialog
          title="Delete saved search"
          body={<>Delete <b>{confirmDelete.ref}</b>?</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteM.mutate({ name: confirmDelete.ref })}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
