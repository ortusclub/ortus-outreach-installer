// Read-only forecast for the app’s five-field schedules, in local time.
export function nextCronRun(expr, from = new Date()) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const parse = (field, lo, hi) => {
    const out = new Set();
    for (const part of field.split(',')) {
      const [range, stepRaw] = part.split('/');
      const step = Math.max(1, parseInt(stepRaw, 10) || 1);
      let a = lo, b = hi;
      if (range !== '*') { const [x, y] = range.split('-'); a = parseInt(x, 10); b = y === undefined ? a : parseInt(y, 10); }
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return out;
  };
  const mins = parse(f[0], 0, 59), hrs = parse(f[1], 0, 23), dom = parse(f[2], 1, 31), mon = parse(f[3], 1, 12), dowRaw = parse(f[4], 0, 7);
  if (!mins || !hrs || !dom || !mon || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => d % 7));
  const domAny = f[2] === '*', dowAny = f[4] === '*';
  const d = new Date(from.getTime()); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let day = 0; day < 370; day++) {
    const dayOk = mon.has(d.getMonth() + 1) && (domAny && dowAny ? true
      : domAny ? dow.has(d.getDay()) : dowAny ? dom.has(d.getDate()) : (dom.has(d.getDate()) || dow.has(d.getDay())));
    if (dayOk) {
      for (let h = d.getHours(); h < 24; h++) {
        if (!hrs.has(h)) continue;
        for (let m = (h === d.getHours() ? d.getMinutes() : 0); m < 60; m++) {
          if (mins.has(m)) { const r = new Date(d.getTime()); r.setHours(h, m, 0, 0); return r; }
        }
      }
    }
    d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
  }
  return null;
}
