// public/js/ui-preview.mjs — loaded ONLY when the URL carries ?uipreview=1.
//
// Hypothesis data. Seeds the three states the 18-Aug fixes produce, on the real
// board, so they can be judged before anything ships. It draws nothing of its
// own: the warning is the markup the strip renderer emits, the toast is
// #campaign-toast, the stop line is the engine's wording in the strip's own log
// box. No network calls, no writes. Without the flag this file is never fetched.

// Fix 3 — the warning belongs to the ONE campaign whose account is logged out.
// Seeded onto the first live strip only, never board-wide.
const WARN_HTML = `
  <div class="sn-acctwarn">
    <span class="sn-acctwarn-txt">This account is logged out of LinkedIn — it sends nothing until you log back in on GoLogin</span>
    <span class="sn-acctwarn-pills"><button type="button" class="stg-acct"><span class="cap-badge bad"><span class="nm">danicaf</span><span class="n">Logged out</span></span></button></span>
  </div>`;

// Fix 2 — what the engine writes when it gives the accounts back.
const STOP_LINE = '🛑 Stopped sending — no account has been able to send for 20h. The accounts are released so other campaigns can use them; already-sent connects keep being checked for acceptances, and the unsent leads stay queued for a restart.';

const liveStrip = () => [...document.querySelectorAll('.sn-strip')]
  .find((s) => /\brun\b|\bmonitoring\b/.test(s.className) && s.querySelector('.sn-flow'));

// The board repaints every ~5s from live data and wipes the seed (correctly —
// none of these campaigns has a logged-out account today), so re-seed on a tick.
setInterval(() => {
  const strip = liveStrip();
  if (!strip) return;
  const flow = strip.querySelector('.sn-flow');
  if (flow && !strip.querySelector('.sn-acctwarn')) flow.insertAdjacentHTML('afterend', WARN_HTML);
  const box = strip.querySelector('.sn-logbox');
  if (box && !box.dataset.uipreview) {
    box.dataset.uipreview = '1';
    box.innerHTML = `<span style="color:var(--ink)">${STOP_LINE}</span><br>` + box.innerHTML;
  }
}, 400);

// Fix 1 — the two screens of a cancelled launch, on demand.
function bar() {
  const b = document.createElement('div');
  b.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;display:flex;gap:8px;flex-direction:column;align-items:flex-end';
  b.innerHTML = `
    <div style="font-family:var(--mono);font-size:.55rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gray)">Preview · hypothesis data</div>
    <button id="uip-scrim" style="font-family:var(--mono);font-size:.66rem;padding:9px 14px;border:1px solid var(--hairline);border-radius:9999px;background:var(--bg);color:var(--ink);cursor:pointer">1 · Scrim click → confirm</button>
    <button id="uip-toast" style="font-family:var(--mono);font-size:.66rem;padding:9px 14px;border:1px solid var(--hairline);border-radius:9999px;background:var(--bg);color:var(--ink);cursor:pointer">1 · Cancelled-launch toast</button>`;
  document.body.appendChild(b);
  b.querySelector('#uip-scrim').onclick = () =>
    confirm('Cancel this launch?\n\nThe senders will not be connected and nothing is sent to the cloud. Your campaign stays saved as a draft.');
  b.querySelector('#uip-toast').onclick = () => {
    const t = document.getElementById('campaign-toast');
    if (!t) return;
    t.textContent = 'Launch cancelled at the primary handshake — nothing was sent, and your campaign is still saved as a draft.';
    t.classList.add('visible');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('visible'), 7000);
  };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bar); else bar();

// ── Sketch · what a waiting campaign tells the operator ─────────────────────
// Today a queued cloud campaign says "Queued" and nothing else: no reason, no
// position, no ETA, no reassurance the leads survived. Three variants of the
// same block, drawn with the existing .sn-mon classes so it is the app's own
// typography, seeded onto whatever cards are idle on this board.
const QUEUE_VARIANTS = [
  {
    badge: '● IN THE QUEUE',
    line: 'Starting a VM worker — <b>first send in ~2 min</b> · nothing else is ahead of you · <b>798 leads</b> waiting',
    note: 'Nothing was lost. The VM is waking up — this is normal for the first couple of minutes after a launch.',
  },
  {
    badge: '● 2ND IN LINE',
    line: 'The cloud is full — <b>30 of 30</b> campaigns running · starts in <b>~25 min</b> · <b>1720 leads</b> waiting',
    note: 'One campaign ahead of yours. It starts by itself as soon as a slot frees — you do not need to do anything.',
  },
];

function queueBlock(v) {
  return `<div class="sn-mon sn-queue-preview" style="flex-direction:column;align-items:stretch;gap:4px">`
    + `<div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap">`
    + `<span class="sn-mon-badge">${v.badge}</span>`
    + `<span class="sn-mon-line">${v.line}</span>`
    + `</div>`
    + `<div class="sn-mon-line" style="font-size:11.5px;color:var(--gray)">${v.note}</div>`
    + `</div>`;
}

setInterval(() => {
  let idle = [...document.querySelectorAll('.sn-strip.queued, .sn-strip.sched')];
  if (!idle.length) return;
  // The board rarely has two waiting campaigns at once, so clone the one it has
  // to put both variants side by side. The clone is inert — buttons stripped.
  while (idle.length < QUEUE_VARIANTS.length) {
    const c = idle[0].cloneNode(true);
    c.dataset.uipreviewClone = '1';
    c.querySelectorAll('.sn-queue-preview').forEach((n) => n.remove());
    c.querySelectorAll('button').forEach((b) => { b.onclick = null; b.disabled = true; });
    idle[0].parentNode.insertBefore(c, idle[0].nextSibling);
    idle = [...document.querySelectorAll('.sn-strip.queued, .sn-strip.sched')];
  }
  idle.forEach((strip, i) => {
    if (strip.querySelector('.sn-queue-preview')) return;
    const flow = strip.querySelector('.sn-flow');
    const v = QUEUE_VARIANTS[i % QUEUE_VARIANTS.length];
    if (flow) flow.insertAdjacentHTML('afterend', queueBlock(v));
    // Variant 2 is the "cloud is full" wait, not a scheduled start — say so in
    // the status slot instead of leaving the ⏰ Scheduled pill lying.
    if (i > 0) {
      const st = strip.querySelector('.sn-status, .sn-statustxt, .sn-when');
      if (st) st.textContent = 'in ~25 min';
      strip.querySelectorAll('.sn-when-pill').forEach((n) => { n.textContent = '⏳ Waiting'; });
    }
  });
}, 400);
