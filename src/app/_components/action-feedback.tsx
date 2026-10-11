"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";

type Notice = { message: string; error?: boolean; undo?: () => Promise<void> };
// ponytail: one latest-action undo, not a history; use a command stack if multi-step undo is needed.
const FeedbackContext = createContext<(notice: Notice) => void>(() => undefined);

export const useActionFeedback = () => useContext(FeedbackContext);

export function ActionFeedback({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undoing, setUndoing] = useState(false);
  const notify = useCallback((next: Notice) => setNotice(next), []);
  const client = useQueryClient();
  const pending = useIsMutating() > 0 || undoing;

  useEffect(() => client.getMutationCache().subscribe((event) => {
    if (event.type !== "updated") return;
    if (event.action.type === "error") {
      const error: unknown = event.mutation.state.error;
      setNotice({ message: error instanceof Error ? error.message : "Action failed. Please try again.", error: true });
    } else if (event.action.type === "success" && !event.mutation.options.meta?.customFeedback) {
      setNotice({ message: "Done." });
    }
  }), [client]);

  const undo = async () => {
    if (!notice?.undo) return;
    setUndoing(true);
    try {
      await notice.undo();
      setNotice({ message: "Undone." });
    } catch (error) {
      // Keep the undo available if a transient failure prevented it.
      setNotice({ ...notice, message: error instanceof Error ? error.message : "Undo failed. Please try again.", error: true });
    } finally {
      setUndoing(false);
    }
  };

  return (
    <FeedbackContext.Provider value={notify}>
      {children}
      {(pending || notice) && (
        <div className="action-feedback" aria-busy={pending}>
          <span role={notice?.error ? "alert" : "status"}>{pending ? "Working…" : notice?.message}</span>
          {notice?.undo && <button className="btn" disabled={pending} onClick={() => void undo()}>Undo</button>}
          <button className="btn" aria-label="Dismiss notification" disabled={pending} onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}
