/**
 * Pure predicate: should the "you probably don't need a note" hint be shown?
 * True only when the connection-note textarea holds non-whitespace text.
 * Lives in public/js so both app.js (browser) and node --test can import it.
 */
export function shouldShowNoteHint(noteText) {
  return typeof noteText === 'string' && noteText.trim().length > 0;
}
