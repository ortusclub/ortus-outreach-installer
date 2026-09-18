const LOCAL_BROWSER_NAMES = new Set(['you', 'local browser', 'local-browser', 'local-browser - manual']);

/** Match only Sender values in the selected tab to browsers we can actually open. */
export function resolveMonitoringTabSenders(rows, profiles) {
  const byName = new Map();
  const ambiguous = new Set();
  for (const profile of profiles || []) {
    const name = String(profile.name || '').trim();
    if (!profile.id || !name) continue;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing && existing.id !== profile.id) ambiguous.add(key);
    else byName.set(key, { id: profile.id, name });
  }
  for (const name of LOCAL_BROWSER_NAMES) {
    if (byName.has(name)) ambiguous.add(name);
    else byName.set(name, { id: 'local-browser', name: 'You' });
  }

  const ids = [];
  const names = {};
  const unresolved = new Set();
  const seen = new Set();
  for (const row of rows || []) {
    const sender = String(row.Sender || row.sender || row['Account Used'] || row['account used'] || '').trim();
    const key = sender.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const match = ambiguous.has(key) ? null : byName.get(key);
    if (!match) { unresolved.add(sender); continue; }
    if (!names[match.id]) ids.push(match.id);
    names[match.id] = match.name;
  }
  return { ids, names, unresolved: [...unresolved] };
}
