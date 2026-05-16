// Onboarding tour — DOM-spotlight + callout walkthrough of the wizard.
//
// 5 steps mapped to existing wizard sections (#nav-settings, #nav-sheet,
// #nav-accounts, #nav-templates, #nav-launch). Each step opens its target
// section if collapsed, scrolls it into view, draws a full-screen overlay
// with a polygon clip-path that punches a hole around the target's bounding
// rect, and renders a callout next to the hole.
//
// First-launch trigger fires once when localStorage.ortusTourCompleted is
// absent. Finish/Skip writes the flag. "Replay tour" in the sidebar Help
// popover clears the flag and starts the tour again.
//
// Pure helpers (TOUR_STEPS, getStepByIndex, nextIndex, prevIndex,
// computeSpotlightClipPath, isTourCompleted/markTourCompleted/resetTourCompletion)
// are exported for unit testing. DOM-dependent functions (startTour,
// renderTour, etc.) are tested via manual browser verification per project
// convention.

export const TOUR_STEPS = [
  {
    id: 'campaign-type',
    targetId: 'nav-settings',
    stepLabel: 'STEP 1 / 5',
    title: 'PICK WHAT YOUR CAMPAIGN DOES',
    body: "Each mode behaves differently — Connect, Message, 3-way Intro, InMail, Open Profile. The modal that fires when you press Start will explain that mode's specifics.",
  },
  {
    id: 'data',
    targetId: 'nav-sheet',
    stepLabel: 'STEP 2 / 5',
    title: 'PASTE YOUR GOOGLE SHEET',
    body: 'Ortus reads rows from here and writes back the Stage column. Sheet must be shared with the Apps Script account. Watch out for trailing spaces in column headers — they break variable substitution silently.',
  },
  {
    id: 'accounts',
    targetId: 'nav-accounts',
    stepLabel: 'STEP 3 / 5',
    title: 'SELECT LINKEDIN ACCOUNTS',
    body: 'Pick which GoLogin profiles run this campaign. Multiple accounts rotate through the lead list — more accounts = higher daily throughput. Status badges show which ones are healthy before launch.',
  },
  {
    id: 'templates',
    targetId: 'nav-templates',
    stepLabel: 'STEP 4 / 5',
    title: 'TEMPLATES + PACING',
    body: 'Write the messages. Variable chips substitute from sheet columns at send time — click a chip to insert it at the cursor. For CC+IC: Acceptance Tracking window and auto-check cadence live here too.',
  },
  {
    id: 'launch',
    targetId: 'nav-launch',
    stepLabel: 'STEP 5 / 5',
    title: 'NAME IT, PRESS START',
    body: 'Name your campaign (used in the dashboard later) and press Start. The cockpit takes over and a mode-specific tips modal fires once explaining things to know about that mode.',
  },
];

// ── Pure: step navigation ────────────────────────────────────────────────

export function getStepByIndex(i) {
  if (!Number.isInteger(i) || i < 0 || i >= TOUR_STEPS.length) return null;
  return TOUR_STEPS[i];
}

export function nextIndex(current, total = TOUR_STEPS.length) {
  if (!Number.isInteger(current)) return 0;
  return Math.min(current + 1, total - 1);
}

export function prevIndex(current) {
  if (!Number.isInteger(current)) return 0;
  return Math.max(current - 1, 0);
}

export function isLastStep(i, total = TOUR_STEPS.length) {
  return i === total - 1;
}

export function isFirstStep(i) {
  return i === 0;
}

// ── Pure: spotlight clip-path math ──────────────────────────────────────
//
// Given a target rect (top/left/right/bottom in viewport coords) and the
// viewport size, return a `polygon(...)` clip-path that covers the whole
// viewport with a rectangular hole at the target. The polygon is drawn as
// an outer rectangle that re-enters at the hole's top, goes around it
// clockwise, then back out to the outer rectangle.
//
// Geometry (8 points): outer-TL → outer-TR → outer-BR → outer-BL → outer-TL
// is the outer rect; we splice in a bridge into the hole and a CW loop
// around the hole, then bridge back out.

export function computeSpotlightClipPath(rect, viewport, padding = 8) {
  const vw = viewport?.width || 0;
  const vh = viewport?.height || 0;
  if (!rect || vw <= 0 || vh <= 0) {
    // No target / no viewport — return a full-cover clip-path (no hole).
    return `polygon(0 0, ${vw}px 0, ${vw}px ${vh}px, 0 ${vh}px)`;
  }
  const t = Math.max(0, rect.top - padding);
  const l = Math.max(0, rect.left - padding);
  const r = Math.min(vw, rect.right + padding);
  const b = Math.min(vh, rect.bottom + padding);
  // Degenerate hole (zero or negative area) — fall back to full cover.
  if (r <= l || b <= t) return `polygon(0 0, ${vw}px 0, ${vw}px ${vh}px, 0 ${vh}px)`;
  return `polygon(
    0 0,
    ${vw}px 0,
    ${vw}px ${vh}px,
    0 ${vh}px,
    0 ${t}px,
    ${l}px ${t}px,
    ${l}px ${b}px,
    ${r}px ${b}px,
    ${r}px ${t}px,
    0 ${t}px
  )`.replace(/\s+/g, ' ').trim();
}

// ── Pure: completion flag I/O (testable via localStorage stub) ──────────

const COMPLETION_KEY = 'ortusTourCompleted';

export function isTourCompleted(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return false;
  try { return storage.getItem(COMPLETION_KEY) === '1'; }
  catch { return false; }
}

export function markTourCompleted(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return;
  try { storage.setItem(COMPLETION_KEY, '1'); }
  catch { /* private mode / no storage */ }
}

export function resetTourCompletion(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return;
  try { storage.removeItem(COMPLETION_KEY); }
  catch { /* */ }
}

// ── Pure: callout positioning (decide top/bottom + offset) ──────────────
//
// Given the target rect and the callout's known size, decide whether the
// callout sits below or above the target. Prefers below when there's room;
// flips above if not. Horizontally aligns to the target's left edge,
// clamped to the viewport so it doesn't slide off-screen.

export function computeCalloutPosition(rect, viewport, calloutSize, gap = 18) {
  const vw = viewport?.width || 0;
  const vh = viewport?.height || 0;
  const cw = calloutSize?.width || 320;
  const ch = calloutSize?.height || 200;

  // Default: below the target.
  let top = (rect?.bottom || 0) + gap;
  let placement = 'below';

  // Flip above if below would overflow.
  if (top + ch > vh) {
    const aboveTop = (rect?.top || 0) - ch - gap;
    if (aboveTop >= 0) {
      top = aboveTop;
      placement = 'above';
    } else {
      // Neither fits comfortably — pin to bottom of viewport.
      top = Math.max(8, vh - ch - 8);
      placement = 'below';
    }
  }

  // Horizontal: align to target's left edge, clamped.
  let left = rect?.left || 0;
  if (left + cw > vw - 8) left = vw - cw - 8;
  if (left < 8) left = 8;

  return { top, left, placement };
}

// ─────────────────────────────────────────────────────────────────────────
// DOM-dependent functions below this line. Imported and called by app.js.
// Not unit-tested — manual browser verification per project convention.
// ─────────────────────────────────────────────────────────────────────────

let _tourState = null;

function _getOverlay() {
  return document.getElementById('tour-overlay');
}

function _getTargetElement(targetId) {
  return document.getElementById(targetId);
}

function _expandSectionIfCollapsed(el) {
  // Wizard sections use `.collapsible.collapsed`; toggleSection() toggles
  // the class. We open them programmatically by removing 'collapsed'.
  if (el?.classList?.contains('collapsible') && el.classList.contains('collapsed')) {
    el.classList.remove('collapsed');
  }
}

function _scrollTargetIntoView(el) {
  try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  catch { el.scrollIntoView(); }
}

function _renderCurrentStep() {
  if (!_tourState) return;
  const overlay = _getOverlay();
  if (!overlay) return;
  const step = getStepByIndex(_tourState.index);
  if (!step) { endTour(false); return; }
  const target = _getTargetElement(step.targetId);
  // Skip when target is missing OR has zero size (parent route hidden, etc.).
  const isMeasurable = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  if (!isMeasurable(target)) {
    if (isLastStep(_tourState.index)) { endTour(true); return; }
    _tourState.index = nextIndex(_tourState.index);
    _renderCurrentStep();
    return;
  }
  _expandSectionIfCollapsed(target);
  _scrollTargetIntoView(target);

  // Defer measurement to next frame so layout settles after scrollIntoView.
  requestAnimationFrame(() => {
    const rect = target.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const spotlight = overlay.querySelector('.tour-spotlight');
    const callout = overlay.querySelector('.tour-callout');
    if (spotlight) spotlight.style.clipPath = computeSpotlightClipPath(rect, viewport);
    if (callout) {
      callout.querySelector('.tour-step').textContent = step.stepLabel;
      callout.querySelector('.tour-title').textContent = step.title;
      callout.querySelector('.tour-body').textContent = step.body;
      // Show/hide Back on step 1
      const backBtn = callout.querySelector('.tour-back');
      if (backBtn) backBtn.style.visibility = isFirstStep(_tourState.index) ? 'hidden' : 'visible';
      // Last step's primary button text
      const nextBtn = callout.querySelector('.tour-next');
      if (nextBtn) nextBtn.textContent = isLastStep(_tourState.index) ? 'FINISH' : 'NEXT →';
      // Position the callout
      const calloutSize = { width: callout.offsetWidth || 320, height: callout.offsetHeight || 200 };
      const pos = computeCalloutPosition(rect, viewport, calloutSize);
      callout.style.top = pos.top + 'px';
      callout.style.left = pos.left + 'px';
      callout.dataset.placement = pos.placement;
    }
  });
}

// Guard: the tour's targets all live inside #wizard-view which is hidden on
// the dashboard route (body.route-dashboard). If we're not on the wizard
// route, navigate there first and wait for layout to settle before
// measuring target rects. Without this, every getBoundingClientRect() comes
// back zero-sized and the spotlight + callout render at top-left.
async function _ensureWizardRoute() {
  const hash = window.location.hash || '#/';
  if (hash.startsWith('#/new')) return;
  window.location.hash = '#/new';
  // 350 ms covers the route-class flip + the wizard's reveal-and-layout.
  await new Promise((r) => setTimeout(r, 350));
}

export async function startTour() {
  await _ensureWizardRoute();
  _tourState = { index: 0 };
  const overlay = _getOverlay();
  if (!overlay) {
    console.warn('[tour] overlay container missing — abort');
    return;
  }
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  _renderCurrentStep();
  // Re-render on scroll / resize so the spotlight follows the target.
  window.addEventListener('scroll', _renderCurrentStep, { passive: true, capture: true });
  window.addEventListener('resize', _renderCurrentStep);
  // Esc dismisses (counts as Skip → marks completed).
  document.addEventListener('keydown', _onTourKey);
}

function _onTourKey(ev) {
  if (ev.key === 'Escape') endTour(true);
  else if (ev.key === 'ArrowRight' || ev.key === 'Enter') tourNext();
  else if (ev.key === 'ArrowLeft') tourBack();
}

export function tourNext() {
  if (!_tourState) return;
  if (isLastStep(_tourState.index)) { endTour(true); return; }
  _tourState.index = nextIndex(_tourState.index);
  _renderCurrentStep();
}

export function tourBack() {
  if (!_tourState) return;
  _tourState.index = prevIndex(_tourState.index);
  _renderCurrentStep();
}

export function tourSkip() {
  endTour(true);
}

export function endTour(markCompleted = true) {
  const overlay = _getOverlay();
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
  window.removeEventListener('scroll', _renderCurrentStep, { capture: true });
  window.removeEventListener('resize', _renderCurrentStep);
  document.removeEventListener('keydown', _onTourKey);
  _tourState = null;
  if (markCompleted) markTourCompleted();
}

export function maybeAutoStartTour() {
  if (isTourCompleted()) return false;
  // Defer until next tick so DOM is fully painted.
  setTimeout(() => {
    startTour().catch((err) => console.warn('[tour] auto-start failed:', err.message));
  }, 600);
  return true;
}

export function replayTour() {
  resetTourCompletion();
  startTour().catch((err) => console.warn('[tour] replay failed:', err.message));
}
