/**
 * Replies panel renderer — Phase 11.3 / 2.9.7.
 *
 * Pure DOM function. Imported by app.js (which is ESM as of Phase 11.3) and
 * directly by Plan 11.3-05 UI tests. NEVER uses innerHTML for LinkedIn-sourced
 * text — participants can send arbitrary strings including `<script>` tags,
 * so everything is textContent or controlled element creation.
 *
 * 2.9.7 — entries now come from per-lead thread scrape:
 *   { match, leadUrl, messages, snippet, inbound, messageCount }
 * Old Voyager shape ({ snippet, threadId, timestamp }) still renders for
 * back-compat with cached results.
 */

export function renderRepliesPanel(container, result) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  if (!result || !result.completedAt) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No scan yet — click "Start Check DMs" to begin.';
    container.appendChild(p);
    return;
  }

  const { byProfile = {}, ambiguous = [], completedAt, errors = [] } = result;

  // Headline summary
  let totalThreads = 0;
  let totalInbound = 0;
  for (const replies of Object.values(byProfile)) {
    if (!Array.isArray(replies)) continue;
    totalThreads += replies.length;
    totalInbound += replies.filter(r => r.inbound).length;
  }

  const summary = document.createElement('div');
  summary.className = 'replies-summary';
  summary.style.cssText = 'display:flex;gap:32px;padding:14px 0;margin-bottom:16px;border-bottom:1px solid var(--hairline-soft, #e6e6e6)';
  summary.appendChild(makeStat(String(totalThreads), 'Threads scanned'));
  summary.appendChild(makeStat(String(totalInbound), 'Inbound replies'));
  summary.appendChild(makeStat(formatTime(completedAt), 'Last run'));
  container.appendChild(summary);

  // Errors block (if any)
  if (Array.isArray(errors) && errors.length > 0) {
    const errWrap = document.createElement('div');
    errWrap.className = 'replies-errors';
    errWrap.style.cssText = 'background:#fef2f2;border-left:2px solid #dc2626;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#7f1d1d';
    const h = document.createElement('strong');
    h.textContent = `${errors.length} error(s):`;
    errWrap.appendChild(h);
    const ul = document.createElement('ul');
    ul.style.cssText = 'margin:6px 0 0 16px;padding:0';
    for (const msg of errors.slice(0, 8)) {
      const li = document.createElement('li');
      li.style.cssText = 'margin:2px 0';
      li.textContent = String(msg);
      ul.appendChild(li);
    }
    if (errors.length > 8) {
      const li = document.createElement('li');
      li.style.cssText = 'margin:2px 0;font-style:italic';
      li.textContent = `…and ${errors.length - 8} more`;
      ul.appendChild(li);
    }
    errWrap.appendChild(ul);
    container.appendChild(errWrap);
  }

  if (totalThreads === 0 && ambiguous.length === 0 && errors.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `No threads scanned at ${formatTime(completedAt)}.`;
    container.appendChild(p);
    return;
  }

  // Replies by profile — inbound first, then outbound-only.
  for (const [profileName, replies] of Object.entries(byProfile)) {
    if (!Array.isArray(replies) || replies.length === 0) continue;
    const inbound = replies.filter(r => r.inbound);
    const waiting = replies.filter(r => !r.inbound);

    if (inbound.length > 0) {
      container.appendChild(makeProfileSection(
        profileName,
        `${inbound.length} new repl${inbound.length === 1 ? 'y' : 'ies'}`,
        '#16a34a',
        inbound,
      ));
    }
    if (waiting.length > 0) {
      container.appendChild(makeProfileSection(
        profileName,
        `${waiting.length} awaiting reply`,
        '#9aa0a6',
        waiting,
      ));
    }
  }

  // Ambiguous (legacy)
  if (ambiguous.length > 0) {
    const section = document.createElement('section');
    section.className = 'replies-ambiguous-section';
    section.style.cssText = 'margin-top:16px';
    const header = document.createElement('header');
    header.style.cssText = 'font-family:var(--display, inherit);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9aa0a6;margin-bottom:8px';
    header.textContent = `⚠ Ambiguous — ${ambiguous.length} conversation(s) match multiple sheet rows`;
    section.appendChild(header);
    for (const amb of ambiguous) section.appendChild(renderAmbiguousRow(amb));
    container.appendChild(section);
  }
}

function makeStat(value, label) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px';
  const v = document.createElement('div');
  v.style.cssText = 'font-family:var(--display, inherit);font-size:24px;line-height:1';
  v.textContent = value;
  const l = document.createElement('div');
  l.style.cssText = 'font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#9aa0a6';
  l.textContent = label;
  wrap.appendChild(v);
  wrap.appendChild(l);
  return wrap;
}

function makeProfileSection(profileName, headline, accent, replies) {
  const section = document.createElement('section');
  section.style.cssText = 'margin-bottom:20px';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:baseline;gap:10px;margin-bottom:8px;font-size:13px';
  const dot = document.createElement('span');
  dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:9999px;background:${accent}`;
  header.appendChild(dot);
  const who = document.createElement('strong');
  who.textContent = profileName;
  header.appendChild(who);
  const meta = document.createElement('span');
  meta.style.cssText = 'color:#9aa0a6;font-size:12px';
  meta.textContent = `· ${headline}`;
  header.appendChild(meta);
  section.appendChild(header);

  for (const reply of replies) section.appendChild(renderReplyRow(reply, accent));
  return section;
}

function renderReplyRow(reply, accent) {
  const row = document.createElement('article');
  row.style.cssText = `display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:start;padding:10px 12px;border:1px solid #ececec;border-left:2px solid ${accent || '#9aa0a6'};margin-bottom:6px;font-size:13px`;

  const m = reply.match || {};
  const firstName = m.firstName || m['First Name'] || '';
  const lastName = m.lastName || m['Last Name'] || '';

  const name = document.createElement('div');
  name.style.cssText = 'font-weight:500';
  name.textContent = `${firstName} ${lastName}`.trim() || '(unknown)';
  row.appendChild(name);

  const snippet = document.createElement('div');
  snippet.style.cssText = 'color:#3a3a3a;line-height:1.4';
  snippet.textContent = String(reply.snippet || '').slice(0, 240);
  row.appendChild(snippet);

  const right = document.createElement('div');
  right.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px;color:#9aa0a6;font-size:11px';
  if (reply.messageCount != null) {
    const c = document.createElement('span');
    c.textContent = `${reply.messageCount} msg${reply.messageCount === 1 ? '' : 's'}`;
    right.appendChild(c);
  }
  // Open Thread link — uses leadUrl (new) or threadId (legacy)
  if (reply.leadUrl) {
    const link = document.createElement('a');
    link.href = String(reply.leadUrl);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open Profile →';
    link.style.cssText = 'color:inherit;text-decoration:none;border-bottom:1px solid currentColor';
    right.appendChild(link);
  } else if (reply.threadId) {
    const link = document.createElement('a');
    link.href = `https://www.linkedin.com/messaging/thread/${encodeURIComponent(reply.threadId)}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open Thread →';
    link.style.cssText = 'color:inherit;text-decoration:none;border-bottom:1px solid currentColor';
    right.appendChild(link);
  }
  row.appendChild(right);

  return row;
}

function renderAmbiguousRow(amb) {
  const row = document.createElement('article');
  row.style.cssText = 'display:grid;grid-template-columns:200px 1fr;gap:16px;padding:10px 12px;border:1px solid #f59e0b;border-left:2px solid #f59e0b;margin-bottom:6px;font-size:13px';
  const name = document.createElement('div');
  name.style.cssText = 'font-weight:500';
  const participant = amb.conv?.participant
    ?? (Array.isArray(amb.conv?.participants) ? amb.conv.participants[0] : null);
  name.textContent = participant
    ? `${participant.firstName || ''} ${participant.lastName || ''}`.trim()
    : '(unknown)';
  row.appendChild(name);

  const note = document.createElement('div');
  note.style.cssText = 'color:#3a3a3a;line-height:1.4';
  const count = Array.isArray(amb.candidates) ? amb.candidates.length : '?';
  note.textContent = `Matches ${count} sheet rows — disambiguate manually before this reply can be written.`;
  row.appendChild(note);
  return row;
}

function formatTime(ms) {
  if (!ms) return 'unknown';
  const delta = Date.now() - ms;
  const abs = Math.abs(delta);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ago`;
  if (abs < 7 * 86_400_000) return `${Math.floor(abs / 86_400_000)}d ago`;
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}
