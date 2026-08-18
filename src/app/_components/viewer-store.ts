"use client";

import { useSyncExternalStore } from "react";
import type { FileSummary } from "refr/server/services/search";

/**
 * The active grid publishes its ordered, loaded items here; the Viewer
 * consumes them for prev/next + the carousel (§10.2).
 */
type ViewerList = {
  items: FileSummary[];
  loadMore: (() => void) | null;
  hasMore: boolean;
};

let current: ViewerList = { items: [], loadMore: null, hasMore: false };
const listeners = new Set<() => void>();

export function publishViewerList(list: ViewerList) {
  current = list;
  listeners.forEach((l) => l());
}

export function useViewerList(): ViewerList {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}
