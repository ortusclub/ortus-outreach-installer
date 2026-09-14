export function launchReviewRows(body, { engine, accountName, modeName, tabName }) {
  const t = body.templates || {};
  return [
    ['Campaign', body.name || 'Unnamed campaign'],
    ['Mode', modeName || body.mode],
    ['Runs on', body.runTarget === 'cloud' ? 'Cloud VM' : 'This Mac'],
    ['Engine', engine.scraperEngineVersion || 'Unverified'],
    ['Engine URL', engine.scraperEngineUrl || 'Unverified'],
    ['Accounts', (body.profileIds || []).map(accountName).join(', ') || 'Auto-routed from sheet'],
    ['Primary', t.primaryName ? `${t.primaryName}${t.primaryUrl ? ` · ${t.primaryUrl}` : ''}` : 'Not configured'],
    ['Sheet', body.sheetUrl],
    ['Tab', body.multiTab ? 'Multiple selected tabs' : tabName || (body.sheetGid ? `gid ${body.sheetGid}` : 'Default tab in sheet URL')],
    ...(body.dailyLimit ? [['Daily limit', `${body.dailyLimit} per account`]] : []),
  ];
}

let reviewing = false;
export async function reviewLaunch(body, labels) {
  if (reviewing) return false;
  reviewing = true;
  const previousFocus = document.activeElement;
  let dialog;
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Could not verify the engine for launch review.');
    const engine = await response.json();
    if (!engine.scraperEngineVersion || !engine.scraperEngineUrl) throw new Error('Engine target is unverified.');
    dialog = document.createElement('dialog');
    dialog.className = 'launch-review';
    dialog.setAttribute('aria-labelledby', 'launch-review-title');
    dialog.innerHTML = '<h2 id="launch-review-title">Review before launch</h2><dl></dl><form method="dialog"><button value="cancel" autofocus>Go back</button><button value="confirm" class="launch-review-confirm">Confirm &amp; Start</button></form>';
    const list = dialog.querySelector('dl');
    for (const [label, value] of launchReviewRows(body, { ...labels, engine })) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = String(value || '—');
      list.append(dt, dd);
    }
    document.body.append(dialog);
    return await new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  } finally {
    dialog?.remove();
    previousFocus?.focus();
    reviewing = false;
  }
}
