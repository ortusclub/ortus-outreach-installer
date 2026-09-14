// Only a request observed in this attempt, for this exact recipient, may
// authorize a network-confirmed result. Unknown payload shapes use DOM fallback.
const endpoint = /voyagerRelationshipsDashMemberRelationships.*InvitationCreationResult/i;
const token = value => String(value || '').match(/(?:ACoAA|ACwAA)[A-Za-z0-9_-]+/)?.[0] || '';
const key = value => { try { const u = new URL(value); return u.origin + u.pathname.replace(/\/$/, ''); } catch { return ''; } };

export function invitationRecipientMatches(payload, identity = {}, url = '') {
  let body;
  try { body = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { return false; }
  const expected = new Set([identity.memberUrn, identity.urn, identity.memberId, url].map(token).filter(Boolean));
  // Do not search arbitrary values (sender URNs and unrelated metadata may be present).
  const recipients = [];
  function walk(value, inRecipient = false) {
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
      const recipient = inRecipient || /^(invitee|invitees|inviteeUnion|recipient|recipients|memberProfile)$/i.test(name);
      if (recipient && typeof item === 'string' && token(item)) recipients.push(token(item));
      else if (item && typeof item === 'object') walk(item, recipient);
    }
  }
  walk(body);
  return recipients.length > 0 && new Set(recipients).size === 1 && expected.has(recipients[0]);
}

export function attachVoyagerInvitationCapture(page, identity = {}) {
  const target = page.url(), requests = new WeakSet(), waiters = new Set();
  let captured = null, detached = false;
  const request = req => {
    try {
      if (!endpoint.test(req.url()) || req.method() !== 'POST' || req.frame() !== page.mainFrame()) return;
      if (key(page.url()) !== key(target) || !invitationRecipientMatches(req.postData(), identity, target)) return;
      requests.add(req);
    } catch { /* unavailable request evidence is not confirmation */ }
  };
  const response = async res => {
    try {
      if (detached || !requests.has(res.request()) || key(page.url()) !== key(target)) return;
      const status = res.status();
      let body; try { body = await res.json(); } catch { body = null; }
      if (detached || key(page.url()) !== key(target)) return;
      const urn = body?.data?.value?.invitationUrn || body?.data?.invitationUrn || null;
      // A bare 2xx without an invitation record is not proof of a send.
      const result = { ok: status >= 200 && status < 300 && !!urn, status, urn,
        errorMessage: body?.message || body?.errorDetails?.message || body?.errorMessage || `HTTP ${status}` };
      if (captured) return; // another response must never overwrite this attempt
      captured = result;
      for (const waiter of [...waiters]) waiter(result);
    } catch { /* fail closed */ }
  };
  page.on('request', request); page.on('response', response);
  return {
    waitFor(ms) {
      if (captured || detached) return Promise.resolve(captured);
      return new Promise(resolve => {
        const done = value => { clearTimeout(timer); waiters.delete(done); resolve(value); };
        const timer = setTimeout(() => done(null), ms);
        waiters.add(done);
      });
    },
    fired: () => !!captured,
    detach() { detached = true; page.off('request', request); page.off('response', response); for (const done of [...waiters]) done(null); },
  };
}

// After a rejection, inspect only the original profile's visible top card.
// Never reopen Connect, resend, or convert conflicting evidence into success.
export async function inspectRejectedInvitation(page, { samples = 3, intervalMs = 1500 } = {}) {
  const target = key(page.url());
  for (let i = 0; i < samples; i++) {
    if (page.isClosed() || key(page.url()) !== target) return 'unknown';
    const pending = await page.evaluate(() => {
      const roots = [...document.querySelectorAll('main section:has(h1), main .pv-top-card')];
      return roots.some(root => [...root.querySelectorAll('button, [role="button"]')]
        .some(el => el.getClientRects().length && /^pending$/i.test(el.textContent.trim())));
    }).catch(() => false);
    if (key(page.url()) !== target) return 'unknown';
    if (pending) return 'pending_observed';
    if (i + 1 < samples) await new Promise(r => setTimeout(r, intervalMs));
  }
  return 'unknown';
}
