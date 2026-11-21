"use client";

import { useState } from "react";
import { Icon } from "./icon";
import { ContextMenu, type MenuItem } from "./context-menu";
import { ConfirmDialog, PromptDialog } from "./dialog";
import { isFolder, nodeKeyAt, type TreeLeaf, type TreeNode } from "refr/lib/folder-tree";

export type FolderTreeOps = {
  move: (v: { key: string; parent: string | null; beforeKey: string | null }) => void;
  createFolder: (v: { name: string; parent: string | null }) => void;
  renameFolder: (v: { path: string; newName: string }) => void;
  deleteFolder: (v: { path: string }) => void;
};

type Prompt = { kind: "newFolder"; parent: string | null } | { kind: "renameFolder"; path: string; name: string };

/**
 * Sidebar of leaves in a nested folder tree: renamable, collapsible, and
 * reorderable/movable by native drag-and-drop. The server owns the tree;
 * leaf actions (open, rename, delete…) belong to the caller.
 */
export function FolderTree<L extends TreeLeaf>({
  nodes,
  ops,
  onOpen,
  leafMenu,
  isSelected,
  leafCount,
  empty,
}: {
  nodes: TreeNode<L>[];
  ops: FolderTreeOps;
  onOpen: (leaf: L) => void;
  leafMenu: (leaf: L) => MenuItem[];
  isSelected?: (leaf: L) => boolean;
  leafCount?: (leaf: L) => number | undefined;
  /** shown when the tree has no nodes at all */
  empty?: React.ReactNode;
}) {
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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // -------- drag state
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ parent: string | null; beforeKey: string | null } | null>(null);

  const resetDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  const drop = () => {
    if (dragging && dropAt) ops.move({ key: dragging, parent: dropAt.parent, beforeKey: dropAt.beforeKey });
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
      ? { background: "var(--accent-soft)", outline: "1px solid var(--accent)" }
      : undefined;

  const folderMenu = (path: string): MenuItem[] => [
    { label: "New folder…", onClick: () => setPrompt({ kind: "newFolder", parent: path }) },
    { label: "Rename…", onClick: () => setPrompt({ kind: "renameFolder", path, name: path.split("/").pop()! }) },
    { label: "Delete…", onClick: () => setConfirmDelete(path), danger: true },
  ];

  const renderNodes = (items: TreeNode<L>[], parent: string | null): React.ReactNode[] =>
    items.map((n, i) => {
      const key = nodeKeyAt(n, parent);
      const next = items[i + 1] ? nodeKeyAt(items[i + 1]!, parent) : null;
      if (!isFolder(n)) {
        const selected = isSelected?.(n) ?? false;
        const count = leafCount?.(n);
        return (
          <div
            key={key}
            className={`trow ${selected ? "sel" : ""}`}
            draggable
            onDragStart={dragStart(key)}
            onDragEnd={resetDrag}
            onDragOver={edgeDrop(parent, key, next)}
            onDrop={dropRow}
            style={dropStyle(parent, key, next)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, items: leafMenu(n) });
            }}
          >
            <span className="caret" />
            <button type="button" className="tree-select" aria-current={selected ? "true" : undefined} onClick={() => onOpen(n)}>{n.name}</button>
            {count !== undefined && <span className="count">{count}</span>}
            <button type="button" className="tree-actions" aria-label={`Actions for ${n.name}`} onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom, items: leafMenu(n) });
            }}><Icon name="more" /></button>
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
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, items: folderMenu(path) });
            }}
          >
            <button type="button" className="caret" aria-label={`${open ? "Collapse" : "Expand"} ${n.name}`} aria-expanded={open} onClick={() => toggleFolder(path)}>{open ? "▾" : "▸"}</button>
            <button type="button" className="tree-select" onClick={() => toggleFolder(path)}>{n.name}</button>
            <span className="count">{n.children.length}</span>
            <button type="button" className="tree-actions" aria-label={`Actions for ${n.name}`} onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom, items: folderMenu(path) });
            }}><Icon name="more" /></button>
          </div>
          {open && (
            <div className="tkids">
              {n.children.length > 0
                ? renderNodes(n.children, path)
                : (
                  <div
                    className="trow text-fg-subtle text-xs"
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
      <button type="button" className="btn mt-2" onClick={() => setPrompt({ kind: "newFolder", parent: null })}>+ New folder</button>
      {nodes.length === 0 && empty}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {prompt?.kind === "newFolder" && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          onSubmit={(name) => ops.createFolder({ name, parent: prompt.parent })}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === "renameFolder" && (
        <PromptDialog
          title="Rename folder"
          label="New name"
          initial={prompt.name}
          onSubmit={(newName) => ops.renameFolder({ path: prompt.path, newName })}
          onClose={() => setPrompt(null)}
        />
      )}
      {confirmDelete !== null && (
        <ConfirmDialog
          title="Delete folder"
          body={<>Delete <b>{confirmDelete}</b>? Contents move up to the parent folder.</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => ops.deleteFolder({ path: confirmDelete })}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
