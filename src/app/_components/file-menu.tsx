"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "refr/trpc/react";
import { ContextMenu, type MenuItem } from "./context-menu";
import { cycleButtonFocus, Dialog, TagPromptDialog } from "./dialog";
import { boardAddedFeedback, BoardPickerDialog } from "./board-picker";
import { useTagEdit } from "./tag-actions";
import { moveQueueItems } from "refr/lib/queue-order";
import { useActionFeedback } from "./action-feedback";
import { FILE_SHORTCUTS, matchFileShortcut } from "refr/lib/keyboard";

/** Grid-owned actions the grid hands the menu when it opens (e.g. invert needs all IDs). */
export type GridMenuActions = { invertSelection: () => void };

/**
 * Shared context actions (§10.2) for grid tiles + viewer: queue, palette,
 * send-to, find-similar, bulk tag add/remove.
 */
export function useFileContextMenu(
  selection: Set<string>,
  onSelectionChange?: (s: Set<string>) => void,
  // ponytail: HTML5 drag-and-drop is dead on touch; queue reorder gets Move-to-start/end
  // menu entries as a fallback. Desktop drag still works.
  reorder?: { allIds: string[]; onReorder: (next: string[]) => void },
) {
  const [menu, setMenu] = useState<{ x: number; y: number; fileIds: string[]; grid?: GridMenuActions } | null>(null);
  const [sendPicker, setSendPicker] = useState<{ fileIds: string[] } | null>(null);
  const [boardPicker, setBoardPicker] = useState<{ fileIds: string[]; startNew: boolean } | null>(null);
  const [prompt, setPrompt] = useState<null | { mode: "add" | "remove"; fileIds: string[]; fromSelection: boolean }>(null);
  // set when a tag is actually added from the prompt, so closing it can drop the selection
  const tagAdded = useRef(false);
  const router = useRouter();
  const utils = api.useUtils();
  const notify = useActionFeedback();

  const queueQ = api.queue.get.useQuery();
  const boardsQ = api.boards.list.useQuery();
  const addToBoard = api.boards.addFiles.useMutation({
    meta: { customFeedback: true },
    onSuccess: (r, v) => {
      void utils.boards.invalidate();
      notify(boardAddedFeedback(r, v.name));
    },
  });
  const settings = api.settings.get.useQuery();
  const mlStatus = api.ml.status.useQuery(undefined, {
    // keep polling until the sidecar is up — the menu's "Find similar" entry
    // depends on state === "ready", and that can happen long after page load
    refetchInterval: (q) => (q.state.data?.enabled && q.state.data.state !== "ready" ? 3000 : false),
  });

  const setQueue = api.queue.set.useMutation({ onSuccess: () => void utils.queue.get.invalidate() });
  const sendTo = api.files.sendTo.useMutation({
    meta: { customFeedback: true },
    onSuccess: ({ copied, existing, failed }) => notify({
      message: [
        `Sent ${copied.length} file${copied.length === 1 ? "" : "s"}.`,
        existing.length ? `Skipped ${existing.length} already-existing filename${existing.length === 1 ? "" : "s"}: ${existing.join(", ")}.` : "",
        failed.length ? `Failed ${failed.length}: ${failed.map((f) => `${f.name}: ${f.message}`).join("; ")}.` : "",
      ].filter(Boolean).join(" "),
      error: failed.length > 0,
    }),
  });
  const setTags = useTagEdit();

  const open = (e: React.MouseEvent, fileId: string, grid?: GridMenuActions) => {
    // Actions on an unselected tile act on it alone; selected tiles act on the selection.
    const fileIds = selection.has(fileId) ? [...selection] : [fileId];
    if (!selection.has(fileId) && selection.size > 0) onSelectionChange?.(new Set([fileId]));
    setMenu({ x: e.clientX, y: e.clientY, fileIds, grid });
  };

  const dests = settings.data?.sendToPaths ?? [];
  const destLabel = (d: (typeof dests)[number]) => d.alias ?? d.path.split("/").filter(Boolean).pop() ?? d.path;
  const isFromSelection = (fileIds: string[]) => fileIds.length > 0 && fileIds.every((id) => selection.has(id));

  const toggleQueue = (fileIds: string[]) => {
    const inQueue = queueQ.data ?? [];
    const set = new Set(inQueue);
    if (fileIds.every((id) => inQueue.includes(id))) fileIds.forEach((id) => set.delete(id));
    else fileIds.forEach((id) => set.add(id));
    setQueue.mutate({ fileIds: [...set] });
  };
  const openTagPrompt = (mode: "add" | "remove", fileIds: string[]) => {
    tagAdded.current = false;
    setPrompt({ mode, fileIds, fromSelection: isFromSelection(fileIds) });
  };
  const createPalette = (fileIds: string[]) => router.push(`/palettes?extract=${fileIds[0]}`);
  const openSendPicker = (fileIds: string[]) => {
    if (dests.length === 0) notify({ message: "No Send-to destinations configured.", error: true });
    else setSendPicker({ fileIds });
  };
  const reorderMoves = reorder && (() => {
    const all = reorder.allIds;
    const move = (fileIds: string[], fn: (rest: string[], sel: string[]) => string[]) =>
      reorder.onReorder(fn(all.filter((id) => !fileIds.includes(id)), all.filter((id) => fileIds.includes(id))));
    return {
      moveUp: (fileIds: string[]) => reorder.onReorder(moveQueueItems(all, new Set(fileIds), -1)),
      moveDown: (fileIds: string[]) => reorder.onReorder(moveQueueItems(all, new Set(fileIds), 1)),
      moveStart: (fileIds: string[]) => move(fileIds, (rest, sel) => [...sel, ...rest]),
      moveEnd: (fileIds: string[]) => move(fileIds, (rest, sel) => [...rest, ...sel]),
    };
  })();

  /** Grid keyboard shortcuts; returns true when the key was handled. Invert is grid-owned. */
  const handleKey = (e: KeyboardEvent, fileIds: string[]): boolean => {
    if (fileIds.length === 0) return false;
    const action = matchFileShortcut(e);
    switch (action) {
      case "queue": toggleQueue(fileIds); return true;
      case "addTag": openTagPrompt("add", fileIds); return true;
      case "removeTag": openTagPrompt("remove", fileIds); return true;
      case "palette": createPalette(fileIds); return true;
      case "sendTo": openSendPicker(fileIds); return true;
      case "addToBoard": setBoardPicker({ fileIds, startNew: false }); return true;
      case "moveUp": case "moveDown": case "moveStart": case "moveEnd":
        if (!reorderMoves) return false;
        reorderMoves[action](fileIds);
        return true;
      default: return false;
    }
  };

  const element = (
    <>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildItems(menu.fileIds, menu.grid)}
        />
      )}
      {sendPicker && (
        <Dialog title={`Send ${sendPicker.fileIds.length} file${sendPicker.fileIds.length === 1 ? "" : "s"} to`} onClose={() => setSendPicker(null)}>
          <div className="flex flex-col gap-2" onKeyDown={cycleButtonFocus}>
            {dests.map((d, i) => (
              <button
                key={i}
                type="button"
                className="btn flex-col items-start text-left"
                style={{ height: "auto", padding: "8px 12px" }}
                onClick={() => {
                  sendTo.mutate({ fileIds: sendPicker.fileIds, destIndex: i });
                  setSendPicker(null);
                }}
              >
                <span>{destLabel(d)}</span>
                <span className="text-xs text-fg-subtle">{d.path}</span>
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {boardPicker && (
        <BoardPickerDialog
          fileIds={boardPicker.fileIds}
          startNew={boardPicker.startNew}
          onClose={() => setBoardPicker(null)}
        />
      )}
      {prompt && (
        <TagPromptDialog
          title={prompt.mode === "add" ? "Add tag" : "Remove tag"}
          label={`Tag to ${prompt.mode} ${prompt.fileIds.length > 1 ? `on ${prompt.fileIds.length} files` : ""}`}
          suggestFor={prompt.mode === "add" ? prompt.fileIds : undefined}
          onSubmit={(tag) => {
            if (prompt.mode === "add") tagAdded.current = true;
            setTags.mutate({
              fileIds: prompt.fileIds,
              add: prompt.mode === "add" ? [tag] : [],
              remove: prompt.mode === "remove" ? [tag] : [],
            });
          }}
          onClose={() => {
            // tagging a selection is usually "done with these" — clear it so the next
            // batch starts fresh
            if (tagAdded.current && prompt.fromSelection) onSelectionChange?.(new Set());
            tagAdded.current = false;
            setPrompt(null);
          }}
        />
      )}
    </>
  );

  function buildItems(fileIds: string[], grid?: GridMenuActions): MenuItem[] {
    const inQueue = queueQ.data ?? [];
    const allQueued = fileIds.every((id) => inQueue.includes(id));
    const items: MenuItem[] = [
      { label: allQueued ? "Remove from queue" : "Add to queue", hint: FILE_SHORTCUTS.queue.hint(), onClick: () => toggleQueue(fileIds) },
      { label: "Create palette", hint: FILE_SHORTCUTS.palette.hint(), onClick: () => createPalette(fileIds) },
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
    if (dests.length > 0) {
      items.push({
        label: "Send to",
        hint: FILE_SHORTCUTS.sendTo.hint(),
        submenu: dests.map((d, i) => ({
          label: destLabel(d),
          onClick: () => sendTo.mutate({ fileIds, destIndex: i }),
        })),
      });
    }
    items.push({
      label: "Add to board",
      hint: FILE_SHORTCUTS.addToBoard.hint(),
      submenu: [
        ...(boardsQ.data ?? []).map((b) => ({
          label: b.name,
          onClick: () => addToBoard.mutate({ name: b.name, fileIds }),
        })),
        { label: "New board…", onClick: () => setBoardPicker({ fileIds, startNew: true }) },
      ],
    });
    items.push(
      "sep",
      { label: "Add tag…", hint: FILE_SHORTCUTS.addTag.hint(), onClick: () => openTagPrompt("add", fileIds) },
      { label: "Remove tag…", hint: FILE_SHORTCUTS.removeTag.hint(), onClick: () => openTagPrompt("remove", fileIds) },
    );
    if (grid) {
      items.push("sep", { label: "Invert selection", hint: FILE_SHORTCUTS.invert.hint(), onClick: grid.invertSelection });
    }
    if (reorderMoves) {
      items.push(
        "sep",
        { label: "Move up", hint: FILE_SHORTCUTS.moveUp.hint(), onClick: () => reorderMoves.moveUp(fileIds) },
        { label: "Move down", hint: FILE_SHORTCUTS.moveDown.hint(), onClick: () => reorderMoves.moveDown(fileIds) },
        { label: "Move to start", hint: FILE_SHORTCUTS.moveStart.hint(), onClick: () => reorderMoves.moveStart(fileIds) },
        { label: "Move to end", hint: FILE_SHORTCUTS.moveEnd.hint(), onClick: () => reorderMoves.moveEnd(fileIds) },
      );
    }
    return items;
  }

  return { open, element, handleKey };
}
