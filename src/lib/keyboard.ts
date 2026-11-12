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
