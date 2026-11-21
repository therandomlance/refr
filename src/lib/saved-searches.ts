import type { Sort, Token } from "refr/server/services/search";
import type { TreeFolder, TreeNode } from "./folder-tree";

/** A saved search leaf. `name` is unique across the whole tree. */
export type SavedSearchNode = { t: "search"; name: string; tokens: Token[]; sort?: Sort };
/** A folder of saved searches and subfolders. */
export type SavedFolderNode = TreeFolder<SavedSearchNode>;
export type SavedNode = TreeNode<SavedSearchNode>;

export { childrenAt, extractNode, locateFolder, moveNode, nodeKeyAt } from "./folder-tree";
