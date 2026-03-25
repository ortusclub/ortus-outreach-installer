/* global fetch */

let selectedProfileIds = new Set();
let allProfilesData = []; // Store for filtering
let pollInterval = null;

// ─────────────────────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────────────────────
async function loadProfiles() {
  const loading = document.getElementById('profiles-loading');
  const grid = document.getElementById('profiles-grid');

  loading.textContent = 'Loading profiles…';
  loading.classList.remove('hidden');
  grid.classList.add('hidden');

  try {
    const res = await fetch('/api/profiles');
    const profiles = await res.json();

    if (profiles.error) {
      loading.textContent = `Error: ${profiles.error}`;
      return;
    }

    allProfilesData = profiles;
    loading.classList.add('hidden');
    grid.classList.remove('hidden');

    renderProfiles(profiles);
  } catch (err) {
    loading.textContent = `Failed to load profiles: ${err.message}`;
  }
}

function renderProfiles(profiles) {
  const grid = document.getElementById('profiles-grid');
  grid.innerHTML = '';

  profiles.forEach((p) => {
    const item = document.createElement('label');
    item.className = 'profile-item';
    item.dataset.profileId = p.id;
    item.innerHTML = `
      <input type="checkbox" value="${p.id}" ${selectedProfileIds.has(p.id) ? 'checked' : ''} />
      <div>
        <div class="name">${escHtml(p.name)}</div>
        <div class="id">${p.id}</div>
      </div>
    `;

    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) selectedProfileIds.add(p.id);
      else selectedProfileIds.delete(p.id);
      updateProfileCount();
    });

    grid.appendChild(item);
  });

  updateProfileCount();
}

function filterProfiles() {
  const query = (document.getElementById('profile-search').value || '').toLowerCase().trim();
  if (!query) {
    renderProfiles(allProfilesData);
    return;
  }

  const filtered = allProfilesData.filter((p) =>
    p.name.toLowerCase().includes(query) ||
    p.id.toLowerCase().includes(query) ||
    (p.notes || '').toLowerCase().includes(query)
  );
  renderProfiles(filtered);
}

function selectAllVisible() {
  const checkboxes = document.querySelectorAll('#profiles-grid input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    cb.checked = true;
    selectedProfileIds.add(cb.value);
  });
  updateProfileCount();
}

function deselectAll() {
  selectedProfileIds.clear();
  const checkboxes = document.querySelectorAll('#profiles-grid input[type="checkbox"]');
  checkboxes.forEach((cb) => { cb.checked = false; });
  updateProfileCount();
}

function updateProfileCount() {
  const el = document.getElementById('profiles-count');
  if (el) {
    el.textContent = `${selectedProfileIds.size} selected / ${allProfilesData.length} total`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet preview
// ─────────────────────────────────────────────────────────────────────────────
async function previewSheet() {
  const url = document.getElementById('sheet-url').value.trim();
  const preview = document.getElementById('sheet-preview');

  if (!url) { alert('Enter a Google Sheet URL first.'); return; }

  preview.classList.remove('hidden');
  preview.innerHTML = 'Loading…';

  try {
    const res = await fetch(`/api/sheet/preview?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (data.error) {
      preview.innerHTML = `<p style="color:#f85149">Error: ${escHtml(data.error)}</p>`;
      return;
    }

    let html = `<p style="color:#8b949e; font-size:0.8rem; margin-bottom:8px">${data.totalRows} row(s) found</p>`;

    if (data.preview.length > 0) {
      html += '<table class="preview-table"><thead><tr>';
      data.columns.forEach((col) => { html += `<th>${escHtml(col)}</th>`; });
      html += '</tr></thead><tbody>';

      data.preview.forEach((row) => {
        html += '<tr>';
        data.columns.forEach((col) => { html += `<td>${escHtml(row[col] || '')}</td>`; });
        html += '</tr>';
      });

      html += '</tbody></table>';
    }

    preview.innerHTML = html;
  } catch (err) {
    preview.innerHTML = `<p style="color:#f85149">${escHtml(err.message)}</p>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign control
// ─────────────────────────────────────────────────────────────────────────────
async function startCampaign() {
  const profileIds = Array.from(selectedProfileIds);
  if (profileIds.length === 0) { alert('Select at least one GoLogin profile.'); return; }

  const sheetUrl = document.getElementById('sheet-url').value.trim();
  if (!sheetUrl) { alert('Enter a Google Sheet URL.'); return; }

  const dailyLimit = parseInt(document.getElementById('daily-limit').value, 10);
  if (!dailyLimit || dailyLimit < 1) { alert('Daily limit must be at least 1.'); return; }

  const templates = {
    connectionNote: document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
  };

  const mode = document.getElementById('campaign-mode').value;

  try {
    const res = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds, sheetUrl, templates, dailyLimit, mode }),
    });

    const data = await res.json();
    if (data.error) { alert(`Error: ${data.error}`); return; }
    if (!data.ok) { alert(data.message || 'Could not start campaign.'); return; }

    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-stop').disabled = false;
    startPolling();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function stopCampaign() {
  try {
    await fetch('/api/campaign/stop', { method: 'POST' });
  } catch { /* */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status polling
// ─────────────────────────────────────────────────────────────────────────────
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollStatus, 2000);
  pollStatus();
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
}

async function pollStatus() {
  try {
    const res = await fetch('/api/campaign/status');
    const s = await res.json();

    // Status
    const runEl = document.getElementById('st-running');
    if (s.running) {
      runEl.textContent = 'Running';
      runEl.className = 'value running';
    } else {
      runEl.textContent = 'Idle';
      runEl.className = 'value stopped';
      document.getElementById('btn-start').disabled = false;
      document.getElementById('btn-stop').disabled = true;
      if (s.logs?.length > 0) stopPolling(); // campaign ended
    }

    // Profile
    const profEl = document.getElementById('st-profile');
    profEl.textContent = s.currentProfile || '—';
    profEl.style.fontSize = s.currentProfile ? '0.75rem' : '';

    // Mode
    const modeLabels = {
      auto: 'Auto', connect_only: 'Connect Only', connect_and_message: 'Connect + Msg',
      message_only: 'Message Only', inmail_only: 'InMail Only',
    };
    document.getElementById('st-mode').textContent = modeLabels[s.mode] || s.mode || '—';

    // Counts
    document.getElementById('st-today').textContent = s.processedToday;
    document.getElementById('st-total').textContent = `${s.totalProcessed} / ${s.totalTargets}`;
    document.getElementById('st-skipped').textContent = s.skippedByMode || 0;
    document.getElementById('st-errors').textContent = s.errors.length;

    // Progress bar
    const pct = s.totalTargets > 0 ? Math.round((s.totalProcessed / s.totalTargets) * 100) : 0;
    document.getElementById('st-bar').style.width = pct + '%';

    // Logs
    if (s.logs?.length > 0) {
      const panel = document.getElementById('log-panel');
      panel.innerHTML = s.logs.map((line) => {
        let cls = '';
        if (line.includes('✓') || line.includes('connection_sent') || line.includes('message_sent')) cls = 'success';
        else if (line.includes('✗') || line.includes('Error') || line.includes('error')) cls = 'error';
        else if (line.includes('⚠') || line.includes('Warning') || line.includes('warn')) cls = 'warn';
        else if (line.includes('===') || line.includes('▶')) cls = 'info';
        return `<div class="entry ${cls}">${escHtml(line)}</div>`;
      }).join('');
      panel.scrollTop = panel.scrollHeight;
    }
  } catch { /* ignore polling errors */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
loadProfiles();

// Check if a campaign is already running (e.g. page refresh)
pollStatus();

// Placeholder tag click → insert into the associated input/textarea
document.addEventListener('click', (e) => {
  const tag = e.target.closest('.placeholder-tags .tag');
  if (!tag) return;

  const container = tag.closest('.placeholder-tags');
  const targetId = container?.dataset.target;
  if (!targetId) return;

  const field = document.getElementById(targetId);
  if (!field) return;

  const val = tag.dataset.val;

  // Insert at cursor position (or append)
  if (typeof field.selectionStart === 'number') {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const before = field.value.substring(0, start);
    const after = field.value.substring(end);
    field.value = before + val + after;
    // Move cursor after inserted text
    field.selectionStart = field.selectionEnd = start + val.length;
  } else {
    field.value += val;
  }

  field.focus();
});
