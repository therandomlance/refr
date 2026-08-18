"use client";

import { useEffect, useState } from "react";

export type TreeNodeData = {
  name: string; // display label
  key: string; // full path (folder path or tag path)
  count?: number;
  children?: TreeNodeData[]; // undefined = not loaded yet
  hasChildren?: boolean;
};

/**
 * Lazy expandable tree (§10.2). Caller supplies loadChildren(key) → child nodes;
 * results are cached per key for the component's lifetime.
 */
export function Tree({
  roots,
  loadChildren,
  selected,
  onSelect,
  onContext,
}: {
  roots: TreeNodeData[];
  loadChildren: (key: string) => Promise<TreeNodeData[]>;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onContext?: (key: string, x: number, y: number) => void;
}) {
  return (
    <div>
      {roots.map((n) => (
        <TreeNode
          key={n.key}
          node={n}
          depth={0}
          loadChildren={loadChildren}
          selected={selected}
          onSelect={onSelect}
          onContext={onContext}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  loadChildren,
  selected,
  onSelect,
  onContext,
}: {
  node: TreeNodeData;
  depth: number;
  loadChildren: (key: string) => Promise<TreeNodeData[]>;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onContext?: (key: string, x: number, y: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeNodeData[] | null>(node.children ?? null);
  const expandable = node.hasChildren !== false;

  // auto-expand the selected node and its ancestors so the full path is
  // visible on page load / URL navigation
  const shouldAutoExpand =
    selected !== null &&
    expandable &&
    (selected === node.key || selected.startsWith(node.key + "/"));
  useEffect(() => {
    if (!shouldAutoExpand || open) return;
    let cancelled = false;
    if (children === null) {
      void loadChildren(node.key).then((c) => {
        if (!cancelled) setChildren(c);
      });
    }
    setOpen(true);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoExpand]);

  const toggle = async () => {
    if (!open && children === null) {
      setChildren(await loadChildren(node.key));
    }
    setOpen(!open);
  };

  return (
    <div>
      <div
        className={`trow ${selected === node.key ? "sel" : ""}`}
        onClick={() => onSelect(node.key)}
        onContextMenu={(e) => {
          if (!onContext) return;
          e.preventDefault();
          onContext(node.key, e.clientX, e.clientY);
        }}
      >
        <span
          className="caret"
          onClick={(e) => {
            e.stopPropagation();
            if (expandable) void toggle();
          }}
        >
          {expandable ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="overflow-hidden text-ellipsis">{node.name}</span>
        {node.count !== undefined && <span className="count">{node.count}</span>}
      </div>
      {open && children && children.length > 0 && (
        <div className="tkids">
          {children.map((c) => (
            <TreeNode
              key={c.key}
              node={c}
              depth={depth + 1}
              loadChildren={loadChildren}
              selected={selected}
              onSelect={onSelect}
              onContext={onContext}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Split a path into child segments directly under `prefix`. Used by Browse trees. */
export function childSegments(names: string[], prefix: string | null): TreeNodeData[] {
  const seen = new Map<string, TreeNodeData>();
  for (const name of names) {
    if (prefix !== null && name !== prefix && !name.startsWith(prefix + "/")) continue;
    if (name === prefix) continue;
    const rest = prefix === null ? name : name.slice(prefix.length + 1);
    const seg = rest.split("/")[0]!;
    const key = prefix === null ? seg : prefix + "/" + seg;
    if (!seen.has(key)) {
      seen.set(key, { name: seg, key, hasChildren: names.some((n) => n.startsWith(key + "/")) });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
