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
