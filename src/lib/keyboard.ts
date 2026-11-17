/** Global-shortcut guards shared by the grid, search input and session runner. */

/** The key event came from somewhere the user is typing. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** A modal dialog, context menu or the fullscreen viewer currently owns the keyboard. */
export function overlayOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"], .ctxmenu, .viewer');
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;

/**
 * Grid tile-action shortcuts. Handlers and context-menu hints both read this table so
 * they can't drift apart. Letter keys never fire with Ctrl/⌘/Alt held (browser shortcuts).
 */
export const FILE_SHORTCUTS = {
  queue: { hint: () => "Q", match: (e: KeyboardEvent) => plain(e) && !e.shiftKey && e.key.toLowerCase() === "q" },
  addTag: { hint: () => "T", match: (e: KeyboardEvent) => plain(e) && !e.shiftKey && e.key.toLowerCase() === "t" },
  removeTag: { hint: () => "Shift+T", match: (e: KeyboardEvent) => plain(e) && e.shiftKey && e.key.toLowerCase() === "t" },
  palette: { hint: () => "P", match: (e: KeyboardEvent) => plain(e) && !e.shiftKey && e.key.toLowerCase() === "p" },
  sendTo: { hint: () => "S", match: (e: KeyboardEvent) => plain(e) && !e.shiftKey && e.key.toLowerCase() === "s" },
  invert: {
    hint: () => (isMac() ? "⌘I" : "Ctrl+I"),
    match: (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i",
  },
  moveUp: { hint: () => "Alt+←", match: (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "ArrowLeft" },
  moveDown: { hint: () => "Alt+→", match: (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "ArrowRight" },
  moveStart: { hint: () => "Alt+Home", match: (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "Home" },
  moveEnd: { hint: () => "Alt+End", match: (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "End" },
} as const;
export type FileShortcut = keyof typeof FILE_SHORTCUTS;

export function matchFileShortcut(e: KeyboardEvent): FileShortcut | null {
  for (const [name, s] of Object.entries(FILE_SHORTCUTS)) if (s.match(e)) return name as FileShortcut;
  return null;
}
