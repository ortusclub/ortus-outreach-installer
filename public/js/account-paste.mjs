// Match pasted account identifiers against the loaded GoLogin roster. Never
// guess from a partial email/name: a wrong account could send real messages.
export function previewPastedAccounts(input, profiles, selectable = () => true) {
  const tokens = String(input || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  return tokens.map(token => {
    const key = token.toLowerCase();
    const matches = (profiles || []).filter(p =>
      String(p.name || '').trim().toLowerCase() === key ||
      String(p.id || '').trim().toLowerCase() === key
    );
    if (!matches.length) return { token, status: 'unmatched' };
    if (matches.length > 1) return { token, status: 'ambiguous' };
    const profile = matches[0];
    if (seen.has(profile.id)) return { token, profile, status: 'duplicate' };
    seen.add(profile.id);
    return { token, profile, status: selectable(profile) ? 'ready' : 'unavailable' };
  });
}
