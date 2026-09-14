// Evidence-only recovery. Never infer a recipient from a display name.
export function recoveryAction(account = {}) {
  const reason = String(account.parkReason || '').toLowerCase();
  if (account.shutdownUnconfirmed) return { kind: 'shutdown', label: 'Check shutdown', detail: 'Do not open another browser until closure is confirmed.' };
  if (account.needsLogin || account.sweepAction || /session_expired|needs.?login|logged.?out/.test(reason)) {
    return { kind: 'login', label: 'Log in', detail: 'Open this exact GoLogin profile for manual login. This does not clear its parked state or resume sending.' };
  }
  if (account.verificationLeads?.length || /unconfirmed|needs.?review|uncertain/.test(reason)) {
    return { kind: 'verify', label: 'Verify', detail: 'Review the affected invitation. Verification does not send, clear a hold or resume the campaign.' };
  }
  if (account.weeklyCap || /weekly|throttle|cooldown/.test(reason)) {
    return { kind: 'cooldown', label: 'Review limit', detail: 'Respect the reported limit. Opening this review does not clear the bench or retry an invitation.' };
  }
  return null;
}

export function historyRecoveryAccounts(history = {}) {
  const debrief = history.debrief || {};
  const ids = history.settings?.profileIds || [];
  const names = history.profiles || [];
  const accounts = new Map();
  for (const row of debrief.perAccount || []) {
    if (row.profileId) accounts.set(row.profileId, { profileId: row.profileId, email: row.name || row.profileId, verificationLeads: [] });
  }
  for (const row of debrief.parked || []) {
    if (!row.profileId) continue;
    const a = accounts.get(row.profileId) || { profileId: row.profileId, email: row.pName || row.profileId, verificationLeads: [] };
    a.parkReason = row.reason; a.parked = true;
    a.needsLogin = /session_expired|needs.?login|logged.?out/i.test(row.reason || '');
    accounts.set(row.profileId, a);
  }
  // Index mapping is used only when both persisted arrays are complete and
  // names are unique. Ambiguous legacy records remain unassigned.
  if (ids.length === names.length && new Set(names).size === names.length) {
    ids.forEach((id, i) => { if (!accounts.has(id)) accounts.set(id, { profileId: id, email: names[i], verificationLeads: [] }); });
  }
  for (const skip of debrief.skips || []) {
    if (!/429|unconfirmed|not confirmed|confirming|uncertain|needs.?review/i.test(skip.detail || '')) continue;
    const matches = [...accounts.values()].filter(a => skip.profileId ? a.profileId === skip.profileId : a.email === skip.profileName);
    if (matches.length !== 1 || !safeProfileUrl(skip.url)) continue;
    const a = matches[0];
    if (!a.verificationLeads.some(l => l.url === skip.url)) a.verificationLeads.push({ url: skip.url, name: skip.leadName || skip.url, detail: skip.detail, timestamp: skip.timestamp || '' });
  }
  return [...accounts.values()].filter(a => recoveryAction(a));
}

export function safeProfileUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname)
      && !url.username && !url.password && /^\/in\/[^/]+\/?$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function openRecoveryReview({ account, verify, checkShutdown, openLogin, document: doc = document }) {
  const action = recoveryAction(account);
  if (!action) return;
  const dialog = doc.createElement('dialog');
  dialog.className = 'account-recovery-dialog';
  const title = doc.createElement('h2'); title.textContent = `${account.email || account.profileId} · ${action.label}`;
  const description = doc.createElement('p'); description.textContent = action.detail;
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const close = doc.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = () => dialog.close();
  dialog.append(title, description, status);
  if (action.kind === 'login') {
    if (account.environment === 'vm') {
      const instructions = doc.createElement('p');
      instructions.textContent = '1. Stop the VM campaign and wait for confirmed browser closure. 2. Keep this account idle in other campaigns and on colleagues’ machines. 3. Open the exact profile below in GoLogin and sign into LinkedIn. 4. Close it and save the session, then use the campaign’s explicit Resume review. This dialog does not unbench or resume anything.';
      const profile = doc.createElement('code'); profile.textContent = account.profileId;
      dialog.append(instructions, profile);
    } else {
    const login = doc.createElement('button'); login.type = 'button'; login.textContent = 'Open exact profile for login';
    const progress = doc.createElement('progress');
    progress.className = 'account-login-progress';
    progress.setAttribute('aria-label', 'Opening GoLogin profile');
    progress.hidden = true;
    login.onclick = async () => {
      if (login.disabled) return;
      login.disabled = true;
      login.textContent = 'Opening profile…';
      login.setAttribute('aria-busy', 'true');
      progress.hidden = false;
      status.textContent = 'Opening your GoLogin profile… This may take a little while. Please wait; do not open it again.';
      try { await openLogin(account.profileId); status.textContent = 'Browser opened for manual login. No campaign has been resumed. Use the campaign’s explicit Resume review when ready.'; }
      catch (error) { status.textContent = `Opening was not confirmed: ${error.message}. Check whether the browser opened before trying again.`; }
      finally {
        progress.hidden = true;
        login.removeAttribute('aria-busy');
        login.textContent = 'Open exact profile for login';
        login.disabled = false;
      }
    };
    dialog.append(progress, login);
    }
  }
  if (action.kind === 'verify') {
    const warning = doc.createElement('p');
    warning.textContent = 'This check reads an already-open tab in this exact GoLogin profile. It does not open or navigate a browser, click More/Connect, send an invitation, or mark the lead resolved. Pending is an observation, not permission to resend.';
    dialog.append(warning);
    for (const lead of account.verificationLeads || []) {
      const row = doc.createElement('div'); row.className = 'account-recovery-lead';
      const name = doc.createElement('strong'); name.textContent = lead.name;
      const url = doc.createElement('p'); url.textContent = lead.url;
      const detail = doc.createElement('p'); detail.textContent = [lead.timestamp, lead.detail].filter(Boolean).join(' · ');
      const result = doc.createElement('p'); result.setAttribute('role', 'status');
      const check = doc.createElement('button'); check.type = 'button'; check.textContent = 'Read invitation state';
      check.onclick = async () => {
        check.disabled = true; result.textContent = 'Reading the matching open tab…';
        try { const observation = await verify(account.profileId, lead.url); result.textContent = observation.message; }
        catch (error) { result.textContent = error.message; }
        finally { check.disabled = false; }
      };
      row.append(name, url, detail, check, result); dialog.append(row);
    }
    if (!account.verificationLeads?.length) {
      const missing = doc.createElement('p'); missing.textContent = 'This record does not identify the affected recipient. Review the campaign log first; no broad campaign check or resend has been started.'; dialog.append(missing);
    }
  }
  if (action.kind === 'shutdown') {
    status.textContent = 'Shutdown requires the campaign’s closure receipt. Do not open or retry this account while that receipt remains unconfirmed.';
    const check = doc.createElement('button'); check.type = 'button'; check.textContent = 'Recheck owned process';
    check.onclick = async () => {
      check.disabled = true;
      try { status.textContent = (await checkShutdown(account.profileId)).message; }
      catch (error) { status.textContent = error.message; }
      finally { check.disabled = false; }
    };
    dialog.append(check);
  }
  dialog.append(close); dialog.addEventListener('close', () => dialog.remove(), { once: true });
  doc.body.append(dialog); dialog.showModal();
  return dialog;
}
