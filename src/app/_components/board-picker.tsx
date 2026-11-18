"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "refr/trpc/react";
import { cycleButtonFocus, Dialog } from "./dialog";
import { useActionFeedback } from "./action-feedback";

/** Toast text for boards.addFiles (picker + context-menu submenu). */
export function boardAddedFeedback(r: { added: number; skipped: number }, board: string) {
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  if (r.added === 0) return { message: `Already on ${board}.` };
  return { message: `Added ${files(r.added)} to ${board}.${r.skipped ? ` ${files(r.skipped)} already there.` : ""}` };
}

/**
 * "Add to board" picker (B in any grid) — like the Send-to picker: one button per
 * saved board, ↑/↓ to move, plus "New board…" which swaps in a name field.
 * Opens straight into the name field when there are no boards yet.
 */
export function BoardPickerDialog({
  fileIds,
  startNew,
  onClose,
}: {
  fileIds: string[];
  startNew: boolean;
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const notify = useActionFeedback();
  const boards = api.boards.list.useQuery();
  const [naming, setNaming] = useState(startNew);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const noBoards = boards.data?.length === 0;
  const showName = naming || noBoards;
  useEffect(() => {
    if (showName) inputRef.current?.focus();
  }, [showName]);

  const addFiles = api.boards.addFiles.useMutation({
    meta: { customFeedback: true },
    onSuccess: (r, v) => {
      void utils.boards.invalidate();
      notify(boardAddedFeedback(r, v.name));
    },
  });
  const create = api.boards.create.useMutation({
    meta: { customFeedback: true },
    onSuccess: (stored) => addFiles.mutate({ name: stored, fileIds }),
  });

  const n = fileIds.length;
  return (
    <Dialog title={`Add ${n} file${n === 1 ? "" : "s"} to board`} onClose={onClose}>
      {showName ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = name.trim();
            if (!v) return;
            create.mutate({ name: v });
            onClose();
          }}
        >
          <label className="mb-1 block text-xs text-fg-subtle" htmlFor="new-board-name">New board name</label>
          <input
            id="new-board-name"
            ref={inputRef}
            className="input mb-4 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => (noBoards || startNew ? onClose() : setNaming(false))}>
              {noBoards || startNew ? "Cancel" : "Back"}
            </button>
            <button type="submit" className="btn primary" disabled={!name.trim()}>Create &amp; add</button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2" onKeyDown={cycleButtonFocus}>
          {boards.isLoading && <p role="status" className="text-sm text-fg-subtle">Loading boards…</p>}
          {(boards.data ?? []).map((b) => (
            <button
              key={b.name}
              type="button"
              className="btn flex-col items-start text-left"
              style={{ height: "auto", padding: "8px 12px" }}
              onClick={() => {
                addFiles.mutate({ name: b.name, fileIds });
                onClose();
              }}
            >
              <span>{b.name}</span>
              <span className="text-xs text-fg-subtle">{b.count} image{b.count === 1 ? "" : "s"}</span>
            </button>
          ))}
          {boards.data && (
            <button
              type="button"
              className="btn justify-start"
              style={{ height: "auto", padding: "8px 12px" }}
              onClick={() => setNaming(true)}
            >
              + New board…
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}
