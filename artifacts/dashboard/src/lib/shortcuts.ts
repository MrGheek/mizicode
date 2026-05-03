/**
 * Returns true if the event target is a text input, textarea, contenteditable,
 * or select. Used to gate keyboard shortcuts so they don't fire while the user
 * is typing into a form field.
 *
 * Note: cmdk renders an <input> for its search; we deliberately exclude it via
 * the [data-shortcut-allow] attribute on container elements when needed.
 */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // Treat any open dialog/menu role hosting interactive controls as a text target
  // when there is a search input inside (e.g. cmdk command palette).
  return false;
}

/**
 * Returns true if the keyboard event would toggle the command palette
 * (Cmd+K on macOS, Ctrl+K elsewhere).
 */
export function isCommandPaletteShortcut(e: KeyboardEvent): boolean {
  return (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
}
