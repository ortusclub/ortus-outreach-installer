// Layout A: relocate existing DOM nodes, never clone inputs or rewrite values.
// No API calls, persistence, or campaign execution belongs in this module.
export function mountAutomationLayout(doc = document) {
  if (doc.getElementById('nav-automation')) return;
  const box = doc.getElementById('manifest-auto-box');
  const drawer = doc.getElementById('manifest-drawer');
  const templates = doc.getElementById('nav-templates');
  if (!box || !drawer || !templates) return;
  const section = doc.createElement('section');
  section.id = 'nav-automation';
  section.className = 'section automation-layout';
  section.style.display = 'none';
  section.innerHTML = '<h2>IV.a Campaign Settings — Automation</h2><p class="automation-description">Settings stay open. Choose how the campaign connects, checks acceptances and follows up.</p>';
  templates.before(section);
  section.append(box);
  drawer.hidden = false;
  box.querySelector('.auto-head')?.remove();
  box.querySelector('.auto-nudge')?.remove();
  // Keep the existing readback renderer and cloud warning alive, without
  // repeating every setting above its own editable control.
  const readback = doc.getElementById('manifest-readback');
  if (readback) readback.hidden = true;
  const connect = doc.createElement('div');
  connect.id = 'automation-connect-group';
  connect.className = 'automation-group';
  connect.innerHTML = '<h3>Connect senders to the primary</h3><p class="automation-description">If a sender is not connected to the primary person, it requests that connection.</p>';
  const timing = doc.getElementById('primary-timing-field');
  const accept = doc.getElementById('auto-accept-block');
  timing.before(connect);
  connect.append(timing, accept);
  const source = doc.getElementById('primary-source-field');
  source.classList.add('automation-group');
  const heading = doc.createElement('h3');
  heading.textContent = 'Primary’s browser';
  source.prepend(heading);
  for (const id of ['check-cadence-block', 'follow-up-block']) {
    doc.getElementById(id).classList.add('automation-group');
  }
  // Preserve native checkboxes and existing handlers; supply accessible names.
  const names = {
    'auto-accept-toggle': 'Accept sender invitations as the primary',
    'auto-accept-all-toggle': 'Also accept unrelated pending invitations',
    'auto-checks-toggle': 'Keep checking after sending finishes',
    'follow-up-toggle': 'Send a first follow-up automatically',
  };
  for (const [id, name] of Object.entries(names)) doc.getElementById(id)?.setAttribute('aria-label', name);
}

export function syncAutomationLayout(mode, doc = document) {
  const active = mode === 'connect_and_introduce' || mode === 'connect_and_message';
  const ccic = mode === 'connect_and_introduce';
  const section = doc.getElementById('nav-automation');
  if (!section) return;
  section.style.display = active ? '' : 'none';
  doc.getElementById('automation-connect-group').style.display = ccic ? '' : 'none';
  for (const id of ['primary-source-field', 'primary-timing-field', 'auto-accept-block', 'follow-up-block']) {
    doc.getElementById(id).style.display = ccic ? '' : 'none';
  }
  doc.getElementById('check-cadence-block').style.display = active ? '' : 'none';
  doc.getElementById('intro-config-row').style.display = (ccic || mode === 'introduce_back') ? '' : 'none';
  const heading = doc.querySelector('#check-cadence-block .intro-config-eyebrow');
  if (heading) heading.textContent = ccic ? 'Acceptance checks & introductions' : 'Acceptance checks & messages';
  const templates = doc.querySelector('[data-edit="h2-templates"]');
  const pace = doc.querySelector('[data-edit="h2-pace"]');
  if (templates) templates.textContent = `IV.${active ? 'b' : 'a'} Campaign Settings — Message Templates`;
  if (pace) pace.textContent = `IV.${active ? 'c' : 'b'} Campaign Settings — Rate & Limits`;
}

export function syncFollowUpTiming(on, doc = document) {
  const fields = doc.getElementById('follow-up-fields');
  if (fields) fields.style.display = '';
  const delay = doc.getElementById('follow-up-delay');
  if (delay) delay.disabled = !on;
}
