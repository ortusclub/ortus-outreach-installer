import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCEPT_STEMS, IGNORE_STEMS, ACTION_SELECTOR } from '../src/linkedin/accept-invitation.js';

const SRC = readFileSync(new URL('../src/linkedin/accept-invitation.js', import.meta.url), 'utf8');

// The matcher that runs in the page, mirrored here so the rule itself is tested
// and not just its source text.
const hit = (el) => {
  const al = ((el.getAttribute && el.getAttribute('aria-label')) || '').toLowerCase();
  if (!al) return false;
  if (IGNORE_STEMS.some((v) => al.includes(v))) return false;
  return ACCEPT_STEMS.some((v) => al.includes(v));
};
const el = (tag, aria, text = '') => ({
  tagName: tag, textContent: text, getAttribute: (k) => (k === 'aria-label' ? aria : null),
});

// Captured live from the primary's invitation manager, 2026-09-01.
const CARLS_ACCEPT = el('A', 'Accept Carl Cabico’s invitation');
const CARLS_IGNORE = el('BUTTON', 'Ignore an invitation to connect from Carl Cabico', 'Ignore');
const COOKIE_ACCEPT = el('BUTTON', null, 'Accept');
const COOKIE_REJECT = el('BUTTON', null, 'Reject');

test('an Accept rendered as a link is found — this is the card that was always skipped', () => {
  assert.equal(hit(CARLS_ACCEPT), true);
});

test('the cookie banner Accept is never treated as an invitation', () => {
  // It is a real <button> whose text matches the accept stems; only the absence
  // of an aria-label separates it from an invitation. Clicking it was being
  // logged as "accepted 1 pending invitation(s)".
  assert.equal(hit(COOKIE_ACCEPT), false);
  assert.equal(hit(COOKIE_REJECT), false);
});

test('Ignore is still never clicked', () => {
  assert.equal(hit(CARLS_IGNORE), false);
});

test('the whole live page reduces to exactly one Accept', () => {
  const page = [CARLS_ACCEPT, CARLS_IGNORE, COOKIE_ACCEPT, COOKIE_REJECT,
    el('BUTTON', 'Invite Laura Smiriglia to connect', 'Connect'),
    el('BUTTON', 'Home, 1 new notification', 'Home')];
  assert.deepEqual(page.filter(hit), [CARLS_ACCEPT]);
});

test('localised accepts still match, and their declines still do not', () => {
  assert.equal(hit(el('A', 'Einladung von Carl Cabico annehmen')), true);
  assert.equal(hit(el('BUTTON', 'Einladung von Carl Cabico ignorieren')), false);
  assert.equal(hit(el('A', 'Accetta l’invito di Marco')), true);
  assert.equal(hit(el('BUTTON', 'Rifiuta l’invito di Marco')), false);
});

test('no accept path queries buttons alone any more', () => {
  assert.equal(ACTION_SELECTOR, 'button, a, [role="button"]');
  assert.doesNotMatch(SRC, /document\.querySelectorAll\('button'\)/);
});

test('the sweep names who it accepted instead of only counting', () => {
  assert.match(SRC, /✓ Accept-all: \$\{who\}/);
});

test('a stalled card says whose invitation is still waiting', () => {
  assert.match(SRC, /would not clear after three tries/);
});

test('accept controls with no aria-label are reported, never clicked', () => {
  assert.match(SRC, /none of them names the person it belongs to/);
});

test('no eval in page context — LinkedIn CSP would block it', () => {
  assert.doesNotMatch(SRC, /eval\(/);
});
