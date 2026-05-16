import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOUR_STEPS,
  getStepByIndex,
  nextIndex,
  prevIndex,
  isFirstStep,
  isLastStep,
  computeSpotlightClipPath,
  computeCalloutPosition,
  isTourCompleted,
  markTourCompleted,
  resetTourCompletion,
} from '../public/js/tour.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Step navigation
// ─────────────────────────────────────────────────────────────────────────

test('TOUR_STEPS has 5 entries covering the wizard sections', () => {
  assert.equal(TOUR_STEPS.length, 5);
  assert.deepEqual(TOUR_STEPS.map(s => s.targetId), [
    'nav-settings',
    'nav-sheet',
    'nav-accounts',
    'nav-templates',
    'nav-launch',
  ]);
});

test('every step has id, targetId, stepLabel, title, body', () => {
  for (const step of TOUR_STEPS) {
    assert.ok(step.id, 'missing id');
    assert.ok(step.targetId, 'missing targetId');
    assert.ok(step.stepLabel, 'missing stepLabel');
    assert.ok(step.title, 'missing title');
    assert.ok(step.body, 'missing body');
    assert.ok(step.body.length > 30, 'body should be at least one sentence');
  }
});

test('getStepByIndex returns step or null at bounds', () => {
  assert.equal(getStepByIndex(0).targetId, 'nav-settings');
  assert.equal(getStepByIndex(4).targetId, 'nav-launch');
  assert.equal(getStepByIndex(-1), null);
  assert.equal(getStepByIndex(5), null);
  assert.equal(getStepByIndex(99), null);
  assert.equal(getStepByIndex('nope'), null);
});

test('nextIndex advances within bounds and clamps at last', () => {
  assert.equal(nextIndex(0), 1);
  assert.equal(nextIndex(3), 4);
  assert.equal(nextIndex(4), 4);  // clamped at last
  assert.equal(nextIndex(100), 4);
  assert.equal(nextIndex(null), 0);
});

test('prevIndex steps back and clamps at first', () => {
  assert.equal(prevIndex(4), 3);
  assert.equal(prevIndex(1), 0);
  assert.equal(prevIndex(0), 0);  // clamped at first
  assert.equal(prevIndex(-5), 0);
});

test('isFirstStep / isLastStep edge predicates', () => {
  assert.equal(isFirstStep(0), true);
  assert.equal(isFirstStep(1), false);
  assert.equal(isLastStep(4), true);
  assert.equal(isLastStep(3), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Spotlight clip-path math
// ─────────────────────────────────────────────────────────────────────────

test('computeSpotlightClipPath returns full-cover when target missing', () => {
  const cp = computeSpotlightClipPath(null, { width: 1024, height: 768 });
  // No hole — just the outer rectangle (4 points).
  assert.ok(cp.startsWith('polygon('));
  assert.ok(cp.includes('1024px 0'));
  assert.ok(cp.includes('1024px 768px'));
  assert.equal((cp.match(/,/g) || []).length, 3); // 4 points = 3 commas inside
});

test('computeSpotlightClipPath punches a hole with 10 vertices when target valid', () => {
  const cp = computeSpotlightClipPath(
    { top: 100, left: 80, right: 480, bottom: 240 },
    { width: 1024, height: 768 }
  );
  // 4 outer + 6 inner (hole bridge) = 10 vertices = 9 commas
  assert.equal((cp.match(/,/g) || []).length, 9);
  // Padding 8 by default — hole should extend to 92 (100-8), 72 (80-8), 488 (480+8), 248 (240+8)
  assert.ok(cp.includes('92px'));
  assert.ok(cp.includes('72px'));
  assert.ok(cp.includes('488px'));
  assert.ok(cp.includes('248px'));
});

test('computeSpotlightClipPath clamps hole to viewport edges', () => {
  // Target rect extends beyond viewport — hole should be clamped.
  const cp = computeSpotlightClipPath(
    { top: -50, left: -30, right: 9999, bottom: 9999 },
    { width: 1024, height: 768 }
  );
  // Hole should clip to (0,0)-(1024,768).
  assert.ok(cp.includes('1024px'));
  assert.ok(cp.includes('768px'));
  // Should NOT contain the negative values literally.
  assert.equal(/-50px/.test(cp), false);
  assert.equal(/-30px/.test(cp), false);
});

test('computeSpotlightClipPath returns full-cover when viewport is zero', () => {
  const cp = computeSpotlightClipPath({ top: 0, left: 0, right: 100, bottom: 100 }, { width: 0, height: 0 });
  // Just degenerate full-cover, no hole.
  assert.equal((cp.match(/,/g) || []).length, 3);
});

// ─────────────────────────────────────────────────────────────────────────
// Callout positioning
// ─────────────────────────────────────────────────────────────────────────

test('computeCalloutPosition places below target when room available', () => {
  const pos = computeCalloutPosition(
    { top: 100, left: 200, right: 500, bottom: 300 },
    { width: 1024, height: 768 },
    { width: 320, height: 180 }
  );
  // Below: top = bottom (300) + gap (18) = 318
  assert.equal(pos.placement, 'below');
  assert.equal(pos.top, 318);
  assert.equal(pos.left, 200);  // aligned to target's left
});

test('computeCalloutPosition flips above when below would overflow', () => {
  // Target at the bottom of viewport, callout below would overflow.
  const pos = computeCalloutPosition(
    { top: 600, left: 200, right: 500, bottom: 720 },
    { width: 1024, height: 768 },
    { width: 320, height: 180 }
  );
  // Below would put top at 720+18=738; 738+180=918 > 768. Flip above.
  // Above: top = 600 - 180 - 18 = 402. Should fit.
  assert.equal(pos.placement, 'above');
  assert.equal(pos.top, 402);
});

test('computeCalloutPosition clamps horizontally when callout overflows right edge', () => {
  const pos = computeCalloutPosition(
    { top: 100, left: 900, right: 1000, bottom: 200 },
    { width: 1024, height: 768 },
    { width: 320, height: 180 }
  );
  // left would be 900; 900+320=1220 > 1024. Clamp: left = 1024 - 320 - 8 = 696.
  assert.equal(pos.left, 696);
});

test('computeCalloutPosition clamps to minimum left margin', () => {
  const pos = computeCalloutPosition(
    { top: 100, left: -50, right: 100, bottom: 200 },
    { width: 1024, height: 768 },
    { width: 320, height: 180 }
  );
  // Target's negative left would push callout off-screen. Clamp to 8.
  assert.equal(pos.left, 8);
});

// ─────────────────────────────────────────────────────────────────────────
// Completion flag (in-memory storage stub)
// ─────────────────────────────────────────────────────────────────────────

function makeStorageStub() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    _data: data,
  };
}

test('isTourCompleted reads "1" from storage', () => {
  const s = makeStorageStub();
  assert.equal(isTourCompleted(s), false);
  s.setItem('ortusTourCompleted', '1');
  assert.equal(isTourCompleted(s), true);
});

test('markTourCompleted writes "1"', () => {
  const s = makeStorageStub();
  markTourCompleted(s);
  assert.equal(s._data.get('ortusTourCompleted'), '1');
  assert.equal(isTourCompleted(s), true);
});

test('resetTourCompletion removes the key', () => {
  const s = makeStorageStub();
  markTourCompleted(s);
  resetTourCompletion(s);
  assert.equal(s._data.has('ortusTourCompleted'), false);
  assert.equal(isTourCompleted(s), false);
});

test('completion helpers do not throw with null storage', () => {
  assert.doesNotThrow(() => isTourCompleted(null));
  assert.doesNotThrow(() => markTourCompleted(null));
  assert.doesNotThrow(() => resetTourCompletion(null));
  assert.equal(isTourCompleted(null), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Regression guards — keep the wizard mapping aligned
// ─────────────────────────────────────────────────────────────────────────

test('regression: every step targets an existing wizard section id', () => {
  // The five wizard section IDs in public/index.html. If any get renamed
  // without updating tour.mjs, this test fails.
  const VALID = new Set(['nav-settings', 'nav-sheet', 'nav-accounts', 'nav-templates', 'nav-launch']);
  for (const step of TOUR_STEPS) {
    assert.ok(VALID.has(step.targetId), `Unknown wizard target: ${step.targetId}`);
  }
});

test('regression: step labels follow "STEP N / 5" format', () => {
  for (let i = 0; i < TOUR_STEPS.length; i++) {
    const expected = `STEP ${i + 1} / 5`;
    assert.equal(TOUR_STEPS[i].stepLabel, expected, `Step ${i} label mismatch`);
  }
});
