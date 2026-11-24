"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icon";
import { StudyFilterDefs, StudyImage } from "./study-image";
import { useStudyTools } from "./study-tools";
import { matchViewerShortcut } from "refr/lib/keyboard";
import { ZOOM_RESET, type ZoomState } from "refr/lib/zoom";
import { useActionFeedback } from "./action-feedback";

type DocumentPip = { requestWindow: (opts: { width: number; height: number }) => Promise<Window> };

/** Always-on-top Document Picture-in-Picture (Chromium) is available. */
export function hasDocumentPip(): boolean {
  return typeof window !== "undefined" && "documentPictureInPicture" in window;
}

/** Copy the app's styles, theme attributes and base URL into a fresh window. */
function prepare(win: Window, title: string) {
  const doc = win.document;
  doc.title = title;
  for (const attr of [...document.documentElement.attributes]) doc.documentElement.setAttribute(attr.name, attr.value);
  const base = doc.createElement("base");
  base.href = window.location.origin + "/";
  doc.head.append(base);
  for (const sheet of [...document.styleSheets]) {
    try {
      const style = doc.createElement("style");
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      doc.head.append(style);
    } catch {
      // cross-origin sheet: link it instead
      if (sheet.href) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        doc.head.append(link);
      }
    }
  }
  doc.body.replaceChildren();
  doc.body.className = document.body.className;
  doc.body.style.margin = "0";
}

/**
 * A second window that React renders into through a portal, so it shares state
 * with the page that opened it (session timer, queue position). Uses Document
 * Picture-in-Picture where available (stays on top of other apps, e.g. a
 * painting program), else a plain same-origin popup. Closes with its owner.
 */
export function usePopout(defaultTitle = "refr reference") {
  const [win, setWin] = useState<Window | null>(null);
  const notify = useActionFeedback();
  const winRef = useRef<Window | null>(null);

  const close = useCallback(() => {
    winRef.current?.close();
    winRef.current = null;
    setWin(null);
  }, []);

  const open = useCallback(async (title = defaultTitle) => {
    if (winRef.current && !winRef.current.closed) {
      winRef.current.document.title = title;
      winRef.current.focus();
      return;
    }
    let w: Window | null = null;
    const pip = (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
    if (pip) {
      try {
        w = await pip.requestWindow({ width: 520, height: 720 });
      } catch {
        w = null; // e.g. not triggered by a user gesture: fall back to a popup
      }
    }
    w ??= window.open("", "refr-reference", "popup,width=520,height=720");
    if (!w) {
      notify({ message: "The browser blocked the reference window. Allow pop-ups for this site.", error: true });
      return;
    }
    prepare(w, title);
    w.addEventListener("pagehide", () => {
      if (winRef.current === w) {
        winRef.current = null;
        setWin(null);
      }
    });
    winRef.current = w;
    setWin(w);
  }, [notify, defaultTitle]);

  // the window only lives as long as the component that owns its state
  useEffect(() => () => winRef.current?.close(), []);

  return { win, open, close };
}

/**
 * The reference view rendered into a pop-out window: one image with the study
 * tools (shared, persisted toggles), prev/next, and an optional HUD (a session
 * timer). Keys inside the window: ←/→ and the viewer's study keys; anything
 * else goes to `onKey` first.
 */
export function PopoutView({
  win,
  ids,
  index,
  onIndex,
  hud,
  onKey,
}: {
  win: Window;
  ids: string[];
  index: number;
  onIndex: (index: number) => void;
  hud?: React.ReactNode;
  onKey?: (e: KeyboardEvent) => boolean;
}) {
  const study = useStudyTools();
  const [zoom, setZoom] = useState<ZoomState>(ZOOM_RESET);
  const id = ids[index];
  useEffect(() => setZoom(ZOOM_RESET), [id]);

  const handler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  handler.current = (e) => {
    if (onKey?.(e)) return e.preventDefault();
    switch (matchViewerShortcut(e)) {
      case "prev": if (index > 0) onIndex(index - 1); break;
      case "next": if (index < ids.length - 1) onIndex(index + 1); break;
      case "close": win.close(); break;
      case "flip": study.toggleFlip(); break;
      case "gray": study.toggleGray(); break;
      case "blur": study.toggleBlur(); break;
      case "value": study.cycleValue(); break;
      case "grid": study.cycleGrid(); break;
      case "resetZoom": setZoom(ZOOM_RESET); break;
      default: return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handler.current(e);
    win.addEventListener("keydown", onKeyDown);
    return () => win.removeEventListener("keydown", onKeyDown);
  }, [win]);

  return createPortal(
    <div className="viewer popout-view">
      <StudyFilterDefs />
      <div className="stage">
        {id ? (
          <StudyImage key={id} id={id} tools={study.tools} zoom={zoom} setZoom={setZoom} />
        ) : (
          <p className="m-auto text-sm text-fg-muted">Nothing to show.</p>
        )}
      </div>
      <div className="popout-hud">
        <button className="chip" aria-label="Previous" disabled={index <= 0} onClick={() => onIndex(index - 1)}><Icon name="left" size={14} /></button>
        <span className="chip tabular-nums">{ids.length ? index + 1 : 0} / {ids.length}</span>
        <button className="chip" aria-label="Next" disabled={index >= ids.length - 1} onClick={() => onIndex(index + 1)}><Icon name="right" size={14} /></button>
        {hud}
      </div>
    </div>,
    win.document.body,
  );
}
