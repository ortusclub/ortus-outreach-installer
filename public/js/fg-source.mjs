// Follower Growth list-source state — pure helpers.
// Imported by public/js/app.js for DOM glue and by tests/fg-source.test.js for
// unit verification. Keep this module DOM-free: no document/window/localStorage.
//
// Stored shape (localStorage 'fg.launch.source.v1'):
//   { pageId, sheetUrl, tab, activeDoor }
// Both doors' content (sheetUrl, tab) is remembered forever; selecting a door
// never destroys the other's value — only `activeDoor` decides what is sent.

/** Which door is live. */
export function fgActiveDoor(saved) {
  const s = saved || {};
  if (s.activeDoor === 'build' || s.activeDoor === 'have') return s.activeDoor;
  // NOT dead code: storage written before `activeDoor` existed has no such key.
  // A stored tab with no sheetUrl is exactly what "Build one for me" left
  // behind, so infer 'build' — defaulting to 'have' there would show an empty
  // URL box and refuse to launch a list the operator already generated.
  if (s.tab && !s.sheetUrl) return 'build';
  return 'have';
}

/** What the active door actually sends — only ever one of the two is set. */
export function fgActivePayload(saved) {
  const s = saved || {};
  return fgActiveDoor(s) === 'build'
    ? { sheetUrl: '', tab: s.tab || '' }
    : { sheetUrl: s.sheetUrl || '', tab: '' };
}
