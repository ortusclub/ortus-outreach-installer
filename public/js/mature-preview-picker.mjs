// Browser availability alone is not evidence of current work.
export function maturingPreviewActivity(item, now = Date.now()) {
  if (!item.live || item.paused || item.stopping || ['paused', 'pausing', 'stopping', 'cancelled', 'error'].includes(item.engineStatus)) return '';
  const progress = item.liveProgress || {};
  const phase = String(progress.phase || '').toLowerCase();
  const raw = progress.stepAt || item.liveStamp?.updatedAt;
  const at = typeof raw === 'number' ? raw : Date.parse(raw || '');
  if (!Number.isFinite(at) || now - at > 120000 || at > now + 5000) return '';
  if (['accepting', 'accepting_connections', 'accepting_requests'].includes(phase)) return 'Accepting';
  if (item.bucket === 'done' || item.engineStatus === 'completed') return '';
  if (item.dailyWait || item.batchDoneToday || ['waiting_daily_reset', 'monitoring', 'scheduled', 'queued', 'pending'].includes(item.engineStatus)) return '';
  return ['sending', 'connecting'].includes(phase) ? 'Connecting' : '';
}
// Warm/cold runs of the same account share one picker entry, preferring a live browser.
export function maturingPreviewAccounts(items) {
  const accounts = new Map();
  const rank = x => maturingPreviewActivity(x) ? 0 : x.bucket === 'done' ? 2 : 1;
  for (const item of items || []) {
    if (!item.id || item.bucket === 'saved' || item.bucket === 'draft') continue;
    const name = String(item.name || item.id).replace(/ · Cold$/, '');
    const previous = accounts.get(name);
    if (!previous || rank(item) < rank(previous)) accounts.set(name, { ...item, name });
  }
  return [...accounts.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map(x => ({ id: x.id, name: x.name, active: !!maturingPreviewActivity(x), status: maturingPreviewActivity(x) || (x.bucket === 'done' ? 'Stopped' : x.paused ? 'Paused' : 'Sleeping') }));
}

export function showMaturingPreviewPicker(items, openPreview) {
  document.getElementById('maturing-preview-picker')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'maturing-preview-picker';
  dialog.setAttribute('aria-label', 'Choose an account to preview');
  const style = document.createElement('style');
  style.textContent = `
    #maturing-preview-picker { position:fixed;inset:0;margin:auto;box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-height:72vh;overflow:auto;padding:24px;border:1px solid var(--hairline);border-radius:20px;background:var(--bg);color:var(--ink);box-shadow:0 18px 60px #0003;font:14px var(--body); }
    #maturing-preview-picker::backdrop { background:#0005; }
    #maturing-preview-picker h3 { font:600 22px var(--body);margin:0 0 8px;outline:none; }
    #maturing-preview-picker h4 { font:600 11px var(--body);letter-spacing:1.2px;text-transform:uppercase;color:var(--gray);margin:22px 0 10px; }
    #maturing-preview-picker p { font-size:13px;line-height:1.5;color:var(--gray);margin:8px 0; }
    #maturing-preview-picker .preview-account { display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:13px 12px;margin:5px 0;border:1px solid var(--hairline);border-radius:10px;font:14px var(--body);letter-spacing:normal;text-transform:none;background:var(--card-bg);color:var(--ink);cursor:pointer; }
    #maturing-preview-picker .preview-account:hover { background:var(--bg-soft);border-color:var(--gray); }
    #maturing-preview-picker .preview-name { flex:1;min-width:0;overflow-wrap:anywhere; }
    #maturing-preview-picker .preview-status { font-size:11px;color:var(--gray);white-space:nowrap; }
    #maturing-preview-picker .is-active .preview-status { color:var(--green); }
    #maturing-preview-picker .preview-dot { width:7px;height:7px;border-radius:50%;background:var(--gray);flex-shrink:0; }
    #maturing-preview-picker .is-active .preview-dot { background:var(--green); }
    #maturing-preview-picker .preview-close { display:block;margin:20px 0 0 auto;padding:8px 20px;border:1px solid var(--hairline);border-radius:999px;background:transparent;color:var(--ink);font:13px var(--body);cursor:pointer; }
    #maturing-preview-picker button:focus-visible { outline:2px solid var(--gold);outline-offset:3px; }
  `;
  dialog.append(style);
  const heading = document.createElement('h3');
  heading.textContent = 'Choose a preview';
  heading.tabIndex = -1;
  dialog.append(heading);
  const hint = document.createElement('p');
  hint.textContent = 'Active means currently connecting or accepting requests.';
  dialog.append(hint);
  const entries = maturingPreviewAccounts(items);
  for (const [label, active] of [['Active now', true], ['Sleeping or stopped', false]]) {
    const section = document.createElement('section');
    const title = document.createElement('h4');
    title.textContent = label;
    section.append(title);
    const rows = entries.filter(x => x.active === active);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = active ? 'No accounts are connecting or accepting right now.' : 'No sleeping or stopped accounts.';
      section.append(empty);
    }
    for (const entry of rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `preview-account${entry.active ? ' is-active' : ''}`;
      const dot = document.createElement('span'); dot.className = 'preview-dot'; dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.className = 'preview-name'; name.textContent = entry.name;
      const status = document.createElement('span'); status.className = 'preview-status'; status.textContent = entry.status;
      button.append(dot, name, status);
      button.addEventListener('click', () => { dialog.close(); openPreview(entry.id, entry.name); });
      section.append(button);
    }
    dialog.append(section);
  }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'preview-close'; close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  dialog.append(close);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', event => {
    const r = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  heading.focus();
}
