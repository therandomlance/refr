"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "refr/trpc/react";
import { ContextMenu, type MenuItem } from "./context-menu";
import { PromptDialog } from "./dialog";

/**
 * Shared context actions (§10.2) for grid tiles + viewer: queue, palette,
 * send-to, find-similar, bulk tag add/remove.
 */
export function useFileContextMenu(
  selection: Set<string>,
  onSelectionChange?: (s: Set<string>) => void,
) {
  const [menu, setMenu] = useState<{ x: number; y: number; fileIds: string[] } | null>(null);
  const [prompt, setPrompt] = useState<null | { mode: "add" | "remove"; fileIds: string[] }>(null);
  const router = useRouter();
  const utils = api.useUtils();

  const queueQ = api.queue.get.useQuery();
  const settings = api.settings.get.useQuery();
  const mlStatus = api.ml.status.useQuery(undefined, {
    // keep polling until the sidecar is up — the menu's "Find similar" entry
    // depends on state === "ready", and that can happen long after page load
    refetchInterval: (q) => (q.state.data?.enabled && q.state.data.state !== "ready" ? 3000 : false),
  });

  const setQueue = api.queue.set.useMutation({ onSuccess: () => void utils.queue.get.invalidate() });
  const sendTo = api.files.sendTo.useMutation();
  const setTags = api.tags.setTags.useMutation({
    onSuccess: () => void utils.tags.invalidate(),
  });

  const open = (e: React.MouseEvent, fileId: string) => {
    // right-click on an unselected tile → act on it alone; on a selected tile → act on selection
    const fileIds = selection.has(fileId) ? [...selection] : [fileId];
    if (!selection.has(fileId) && selection.size > 0) onSelectionChange?.(new Set([fileId]));
    setMenu({ x: e.clientX, y: e.clientY, fileIds });
  };

  const element = (
    <>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildItems(menu.fileIds)}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.mode === "add" ? "Add tag" : "Remove tag"}
          label={`Tag to ${prompt.mode} ${prompt.fileIds.length > 1 ? `on ${prompt.fileIds.length} files` : ""}`}
          onSubmit={(tag) =>
            setTags.mutate({
              fileIds: prompt.fileIds,
              add: prompt.mode === "add" ? [tag] : [],
              remove: prompt.mode === "remove" ? [tag] : [],
            })
          }
          onClose={() => setPrompt(null)}
        />
      )}
    </>
  );

  function buildItems(fileIds: string[]): MenuItem[] {
    const inQueue = queueQ.data ?? [];
    const allQueued = fileIds.every((id) => inQueue.includes(id));
    const queueLabel = allQueued ? "Remove from queue" : "Add to queue";
    const items: MenuItem[] = [
      {
        label: queueLabel,
        onClick: () => {
          const set = new Set(inQueue);
          if (allQueued) fileIds.forEach((id) => set.delete(id));
          else fileIds.forEach((id) => set.add(id));
          setQueue.mutate({ fileIds: [...set] });
        },
      },
      {
        label: "Create palette",
        onClick: () => router.push(`/palettes?extract=${fileIds[0]}`),
      },
    ];
    if (mlStatus.data?.state === "ready") {
      items.push({
        label: "Find similar",
        onClick: () =>
          router.push(
            `/search?q=${encodeURIComponent(
              JSON.stringify([
                { kind: "similar", tag: fileIds[0]!, negate: false, exact: false, or: false, wildcard: false },
              ]),
            )}`,
          ),
      });
    }
    const dests = settings.data?.sendToPaths ?? [];
    if (dests.length > 0) {
      items.push({
        label: "Send to",
        submenu: dests.map((d, i) => ({
          label: d.split("/").filter(Boolean).pop() ?? d,
          onClick: () => sendTo.mutate({ id: fileIds[0]!, destIndex: i }),
        })),
      });
    }
    items.push(
      "sep",
      {
        label: "Tag actions",
        submenu: [
          { label: "Add tag…", onClick: () => setPrompt({ mode: "add", fileIds }) },
          { label: "Remove tag…", onClick: () => setPrompt({ mode: "remove", fileIds }) },
        ],
      },
    );
    return items;
  }

  return { open, element };
}
