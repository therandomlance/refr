import type { Sort, Token } from "refr/server/services/search";

/** A saved search leaf. `name` is unique across the whole tree. */
export type SavedSearchNode = { t: "search"; name: string; tokens: Token[]; sort?: Sort };
/** A folder of saved searches and subfolders. */
export type SavedFolderNode = { t: "folder"; name: string; children: SavedNode[] };
export type SavedNode = SavedFolderNode | SavedSearchNode;

/** Key of `n` given its parent folder path (null = root). Folders are keyed by
 *  full path, searches by global name. */
export function nodeKeyAt(n: SavedNode, parentPath: string | null): string {
  if (n.t === "search") return `s:${n.name}`;
  return `f:${parentPath ? `${parentPath}/${n.name}` : n.name}`;
}

/** Children array of the folder at `path`, or the root array for null. */
export function childrenAt(items: SavedNode[], path: string | null): SavedNode[] | null {
  if (path === null) return items;
  return locateFolder(items, path)?.folder.children ?? null;
}

export function locateFolder(
  items: SavedNode[],
  path: string,
): { siblings: SavedNode[]; index: number; folder: SavedFolderNode } | null {
  const parts = path.split("/");
  let siblings = items;
  for (let d = 0; d < parts.length; d++) {
    const index = siblings.findIndex((n) => n.t === "folder" && n.name === parts[d]);
    if (index < 0) return null;
    const folder = siblings[index] as SavedFolderNode;
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
export function moveNode(
  items: SavedNode[],
  key: string,
  parent: string | null,
  beforeKey: string | null,
): SavedNode[] {
  if (key.startsWith("f:") && parent !== null) {
    const path = key.slice(2);
    if (parent === path || parent.startsWith(path + "/")) return items;
  }
  const next = JSON.parse(JSON.stringify(items)) as SavedNode[];
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
export function extractNode(items: SavedNode[], key: string): SavedNode | null {
  return extract(items, key, null);
}
function extract(items: SavedNode[], key: string, parent: string | null): SavedNode | null {
  for (let i = 0; i < items.length; i++) {
    const n = items[i]!;
    if (nodeKeyAt(n, parent) === key) return items.splice(i, 1)[0]!;
    if (n.t === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      const found = extract(n.children, key, path);
      if (found) return found;
    }
  }
  return null;
}
