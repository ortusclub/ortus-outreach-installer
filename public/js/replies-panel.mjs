/**
 * Replies panel renderer — Phase 11.3.
 *
 * Pure DOM function. Imported by app.js (which is ESM as of Phase 11.3) and
 * directly by Plan 11.3-05 UI tests. NEVER uses innerHTML for LinkedIn-sourced
 * text — participants can send arbitrary strings including `<script>` tags,
 * so everything is textContent or controlled element creation.
 */

/**
 * Render the Replies panel body.
 *
 * @param {HTMLElement} container — the panel body element (e.g. #replies-body)
 * @param {object} result
 *   - byProfile:  { [profileName]: [ { match, conversation, snippet, threadId, timestamp } ] }
 *   - ambiguous:  [ { conv, candidates, profileId } ]
 *   - completedAt: number (ms since epoch)  — null if not yet scanned
 *   - errors:     string[] (optional)
 */
export function renderRepliesPanel(container, result) {
  if (!container) return;
  // Wipe previous contents — never leak DOM between renders
  while (container.firstChild) container.removeChild(container.firstChild);

  if (!result || !result.completedAt) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No scan yet — click "Check DMs" to start.';
    container.appendChild(p);
    return;
  }

  const { byProfile = {}, ambiguous = [], completedAt, errors = [] } = result;

  // Errors block (if any)
  if (Array.isArray(errors) && errors.length > 0) {
    const errWrap = document.createElement('div');
    errWrap.className = 'replies-errors';
    const h = document.createElement('strong');
    h.textContent = `${errors.length} error(s):`;
    errWrap.appendChild(h);
    const ul = document.createElement('ul');
    for (const msg of errors) {
      const li = document.createElement('li');
      li.textContent = String(msg);
      ul.appendChild(li);
    }
    errWrap.appendChild(ul);
    container.appendChild(errWrap);
  }

  // Replies by profile
  const totalReplies = Object.values(byProfile).reduce((n, arr) => n + (arr?.length || 0), 0);

  if (totalReplies === 0 && ambiguous.length === 0 && errors.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `No new replies since ${formatTime(completedAt)}.`;
    container.appendChild(p);
    return;
  }

  for (const [profileName, replies] of Object.entries(byProfile)) {
    if (!replies || replies.length === 0) continue;
    const section = document.createElement('section');
    section.className = 'replies-profile-section';

    const header = document.createElement('header');
    header.className = 'replies-profile-header';
    header.textContent = `${profileName} — ${replies.length} new reply${replies.length === 1 ? '' : 'ies'}`;
    section.appendChild(header);

    for (const reply of replies) {
      section.appendChild(renderReplyRow(reply));
    }
    container.appendChild(section);
  }

  // Ambiguous matches
  if (ambiguous.length > 0) {
    const section = document.createElement('section');
    section.className = 'replies-ambiguous-section';

    const header = document.createElement('header');
    header.className = 'replies-profile-header';
    header.textContent = `⚠ Ambiguous — ${ambiguous.length} conversation(s) match multiple sheet rows`;
    section.appendChild(header);

    for (const amb of ambiguous) {
      section.appendChild(renderAmbiguousRow(amb));
    }
    container.appendChild(section);
  }

  // Footer
  const footer = document.createElement('div');
  footer.className = 'replies-footer muted';
  footer.textContent = `Last checked: ${formatTime(completedAt)}`;
  container.appendChild(footer);
}

function renderReplyRow(reply) {
  const row = document.createElement('article');
  row.className = 'reply-row';

  const name = document.createElement('div');
  name.className = 'reply-name';
  const m = reply.match || {};
  const firstName = m.firstName || m['First Name'] || '';
  const lastName = m.lastName || m['Last Name'] || '';
  name.textContent = `${firstName} ${lastName}`.trim() || '(unknown)';
  row.appendChild(name);

  const snippet = document.createElement('div');
  snippet.className = 'reply-snippet';
  snippet.textContent = `"${String(reply.snippet || '').slice(0, 160)}"`;
  row.appendChild(snippet);

  const meta = document.createElement('div');
  meta.className = 'reply-meta';
  const time = document.createElement('span');
  time.className = 'reply-time';
  time.textContent = formatTime(reply.timestamp);
  meta.appendChild(time);

  if (reply.threadId) {
    const link = document.createElement('a');
    link.className = 'reply-open-thread';
    link.href = `https://www.linkedin.com/messaging/thread/${encodeURIComponent(reply.threadId)}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open Thread';
    meta.appendChild(link);
  }
  row.appendChild(meta);

  return row;
}

function renderAmbiguousRow(amb) {
  const row = document.createElement('article');
  row.className = 'reply-row reply-row--ambiguous';

  const name = document.createElement('div');
  name.className = 'reply-name';
  const participant = amb.conv?.participant
    ?? (Array.isArray(amb.conv?.participants) ? amb.conv.participants[0] : null);
  name.textContent = participant
    ? `${participant.firstName || ''} ${participant.lastName || ''}`.trim()
    : '(unknown)';
  row.appendChild(name);

  const note = document.createElement('div');
  note.className = 'reply-snippet';
  const count = Array.isArray(amb.candidates) ? amb.candidates.length : '?';
  note.textContent = `Matches ${count} sheet rows — disambiguate manually before this reply can be written to the sheet.`;
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
