/**
 * Ordered, nested folder tree shared by the saved-search and mood-board
 * sidebars. Leaves are anything with a `t` tag (not "folder") and a `name`
 * that is unique across the whole tree. Pure; client-safe.
 */

export type TreeLeaf = { t: string; name: string };
export type TreeFolder<L extends TreeLeaf> = { t: "folder"; name: string; children: TreeNode<L>[] };
export type TreeNode<L extends TreeLeaf> = L | TreeFolder<L>;

export function isFolder<L extends TreeLeaf>(n: TreeNode<L>): n is TreeFolder<L> {
  return n.t === "folder";
}

/** Key of `n` given its parent folder path (null = root). Folders are keyed by
 *  full path, leaves by global name. */
export function nodeKeyAt<L extends TreeLeaf>(n: TreeNode<L>, parentPath: string | null): string {
  if (!isFolder(n)) return `s:${n.name}`;
  return `f:${parentPath ? `${parentPath}/${n.name}` : n.name}`;
}

/** Children array of the folder at `path`, or the root array for null. */
export function childrenAt<L extends TreeLeaf>(items: TreeNode<L>[], path: string | null): TreeNode<L>[] | null {
  if (path === null) return items;
  return locateFolder(items, path)?.folder.children ?? null;
}

export function locateFolder<L extends TreeLeaf>(
  items: TreeNode<L>[],
  path: string,
): { siblings: TreeNode<L>[]; index: number; folder: TreeFolder<L> } | null {
  const parts = path.split("/");
  let siblings = items;
  for (let d = 0; d < parts.length; d++) {
    const index = siblings.findIndex((n) => isFolder(n) && n.name === parts[d]);
    if (index < 0) return null;
    const folder = siblings[index] as TreeFolder<L>;
    if (d === parts.length - 1) return { siblings, index, folder };
    siblings = folder.children;
  }
  return null;
}

/**
 * Remove `key` from the tree and re-insert it into `parent` (folder path, null
 * = root) immediately before `beforeKey`, or appended when `beforeKey` is
 * null/stale. Pure. A folder dropped into itself or a descendant is a no-op.
 */
export function moveNode<L extends TreeLeaf>(
  items: TreeNode<L>[],
  key: string,
  parent: string | null,
  beforeKey: string | null,
): TreeNode<L>[] {
  if (key.startsWith("f:") && parent !== null) {
    const path = key.slice(2);
    if (parent === path || parent.startsWith(path + "/")) return items;
  }
  const next = JSON.parse(JSON.stringify(items)) as TreeNode<L>[];
  const node = extractNode(next, key);
  if (!node) return items;
  const target = childrenAt(next, parent);
  if (!target) return items;
  const at = beforeKey ? target.findIndex((n) => nodeKeyAt(n, parent) === beforeKey) : -1;
  if (at >= 0) target.splice(at, 0, node);
  else target.push(node);
  return next;
}

/** Remove the node under `key` (recursively) and return it, or null. */
export function extractNode<L extends TreeLeaf>(items: TreeNode<L>[], key: string): TreeNode<L> | null {
  return extract(items, key, null);
}
function extract<L extends TreeLeaf>(items: TreeNode<L>[], key: string, parent: string | null): TreeNode<L> | null {
  for (let i = 0; i < items.length; i++) {
    const n = items[i]!;
    if (nodeKeyAt(n, parent) === key) return items.splice(i, 1)[0]!;
    if (isFolder(n)) {
      const path = parent ? `${parent}/${n.name}` : n.name;
      const found = extract(n.children, key, path);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------- folder ops (mutate in place; return whether changed)

/** "/" is the path separator, so it can't appear in a folder name. */
export function cleanFolderName(name: string): string {
  return name.trim().replace(/\//g, "-") || "folder";
}

export function addFolder<L extends TreeLeaf>(items: TreeNode<L>[], name: string, parent: string | null): boolean {
  const siblings = childrenAt(items, parent);
  if (!siblings) return false;
  const clean = cleanFolderName(name);
  if (siblings.some((n) => isFolder(n) && n.name === clean)) return false;
  siblings.push({ t: "folder", name: clean, children: [] });
  return true;
}

/** Renaming onto an existing sibling folder merges the two. */
export function renameFolderIn<L extends TreeLeaf>(items: TreeNode<L>[], folderPath: string, newName: string): boolean {
  const loc = locateFolder(items, folderPath);
  if (!loc) return false;
  const clean = cleanFolderName(newName);
  if (clean === loc.folder.name) return false;
  const clash = loc.siblings.find((n): n is TreeFolder<L> => isFolder(n) && n.name === clean);
  if (clash) {
    clash.children.push(...loc.folder.children);
    loc.siblings.splice(loc.index, 1);
  } else {
    loc.folder.name = clean;
  }
  return true;
}

/** Delete a folder, promoting its contents to the parent. */
export function deleteFolderIn<L extends TreeLeaf>(items: TreeNode<L>[], folderPath: string): boolean {
  const loc = locateFolder(items, folderPath);
  if (!loc) return false;
  loc.siblings.splice(loc.index, 1, ...loc.folder.children);
  return true;
}

// ---------------------------------------------------------------- leaf helpers

/** Every leaf, depth-first in display order. */
export function leaves<L extends TreeLeaf>(items: TreeNode<L>[]): L[] {
  return items.flatMap((n) => (isFolder(n) ? leaves(n.children) : [n]));
}

/** Copy of the tree without leaves that fail `keep` (folders are kept). */
export function filterLeaves<L extends TreeLeaf>(items: TreeNode<L>[], keep: (l: L) => boolean): TreeNode<L>[] {
  return items.flatMap((n): TreeNode<L>[] =>
    isFolder(n) ? [{ ...n, children: filterLeaves(n.children, keep) }] : keep(n) ? [n] : [],
  );
}

export function findLeaf<L extends TreeLeaf>(items: TreeNode<L>[], name: string): L | null {
  for (const n of items) {
    if (!isFolder(n) && n.name === name) return n;
    if (isFolder(n)) {
      const c = findLeaf(n.children, name);
      if (c) return c;
    }
  }
  return null;
}
