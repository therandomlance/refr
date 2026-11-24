"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { api } from "refr/trpc/react";
import { PopoutView, usePopout } from "./popout";
import { BoardPopoutView } from "refr/app/(app)/boards/_components/board-popout";

type Content = { kind: "images"; ids: string[]; currentId: string | null } | { kind: "board"; name: string };

type ReferenceWindow = {
  /** Show images (in order) in the reference window, starting at `startId`. */
  openImages: (ids: string[], startId?: string) => void;
  /** Show a whole board, read-only, in the reference window. */
  openBoard: (name: string) => void;
  close: () => void;
  isOpen: boolean;
};

const Ctx = createContext<ReferenceWindow>({ openImages: () => undefined, openBoard: () => undefined, close: () => undefined, isOpen: false });

export const useReferenceWindow = () => useContext(Ctx);

/**
 * App-wide pop-out reference window (popout.tsx), owned by the (app) layout so
 * it survives page navigation. Opening new content replaces what it shows.
 * Sessions keep their own pop-out (it carries the live timer).
 */
export function ReferenceWindowProvider({ children }: { children: React.ReactNode }) {
  const { win, open, close } = usePopout();
  const [content, setContent] = useState<Content | null>(null);

  const openImages = useCallback((ids: string[], startId?: string) => {
    setContent({ kind: "images", ids, currentId: startId ?? ids[0] ?? null });
    void open(ids.length === 1 ? "refr reference" : `refr reference (${ids.length})`);
  }, [open]);
  const openBoard = useCallback((name: string) => {
    setContent({ kind: "board", name });
    void open(`refr board: ${name}`);
  }, [open]);

  const value = useMemo(() => ({ openImages, openBoard, close, isOpen: !!win }), [openImages, openBoard, close, win]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {win && content?.kind === "images" && (
        <ImagesContent win={win} content={content} onCurrent={(currentId) => setContent({ ...content, currentId })} />
      )}
      {win && content?.kind === "board" && <BoardPopoutView key={content.name} name={content.name} win={win} />}
    </Ctx.Provider>
  );
}

function ImagesContent({ win, content, onCurrent }: {
  win: Window;
  content: Extract<Content, { kind: "images" }>;
  onCurrent: (id: string) => void;
}) {
  // only files that still exist (a queue can hold ids whose file was purged)
  const filesQ = api.files.list.useQuery({ ids: content.ids }, { placeholderData: (prev) => prev });
  const ids = useMemo(() => (filesQ.data?.items ?? []).map((f) => f.id), [filesQ.data]);
  if (!filesQ.data) return null;
  const index = Math.max(0, content.currentId ? ids.indexOf(content.currentId) : 0);
  return <PopoutView win={win} ids={ids} index={index} onIndex={(i) => { const id = ids[i]; if (id) onCurrent(id); }} />;
}
