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
  addToBoard: { hint: () => "B", match: (e: KeyboardEvent) => plain(e) && !e.shiftKey && e.key.toLowerCase() === "b" },
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

const letter = (k: string) => (e: KeyboardEvent) => plain(e) && !e.shiftKey && e.key.toLowerCase() === k;
const bare = (k: string) => (e: KeyboardEvent) => plain(e) && !e.shiftKey && e.key === k;

/**
 * Fullscreen-viewer shortcuts — a keymap separate from FILE_SHORTCUTS (those are
 * grid-only; overlayOpen() blocks them while the viewer is up). All entries rank
 * equally, but none may claim a FILE_SHORTCUTS key: those keep precedence so the
 * thumbnail actions can come to the viewer later (enforced in keyboard.test.ts).
 */
export const VIEWER_SHORTCUTS = {
  prev: { hint: () => "←", match: bare("ArrowLeft") },
  next: { hint: () => "→", match: bare("ArrowRight") },
  close: { hint: () => "Esc", match: bare("Escape") },
  panels: { hint: () => "F", match: letter("f") },
  flip: { hint: () => "H", match: letter("h") },
  gray: { hint: () => "G", match: letter("g") },
  blur: { hint: () => "U", match: letter("u") },
  value: { hint: () => "V", match: letter("v") },
  grid: { hint: () => "R", match: letter("r") },
  resetZoom: { hint: () => "0", match: bare("0") },
} as const;
export type ViewerShortcut = keyof typeof VIEWER_SHORTCUTS;

export function matchViewerShortcut(e: KeyboardEvent): ViewerShortcut | null {
  for (const [name, s] of Object.entries(VIEWER_SHORTCUTS)) if (s.match(e)) return name as ViewerShortcut;
  return null;
}
