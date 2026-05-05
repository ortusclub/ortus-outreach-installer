/**
 * src/browser-semaphore.js — global hard cap on simultaneously-open browsers.
 *
 * Type-agnostic: counts heads regardless of whether the browser is GoLogin
 * Orbita (any LinkedIn account 2..N) or local Chromium ("You" profile). When
 * the cap is reached, acquire() returns a Promise that resolves only when
 * release() frees a slot.
 *
 * Default cap = 2. May be lowered to 1 transiently when the resource-monitor
 * trips RAM throttle (Q1=(a) "drain to 1"). Raised back when throttle releases.
 *
 * Module-level singleton — every browser launch site routes through here.
 */

let _max = 2;
let _count = 0;
const _waiters = [];

export async function acquire() {
  if (_count < _max) {
    _count++;
    return;
  }
  return new Promise(resolve => _waiters.push(resolve));
}

export function release() {
  if (_count > 0) _count--;
  if (_waiters.length > 0 && _count < _max) {
    _count++;
    const next = _waiters.shift();
    next();
  }
}

export function setMax(newMax) {
  _max = Math.max(1, Number(newMax) || 1);
  while (_waiters.length > 0 && _count < _max) {
    _count++;
    const next = _waiters.shift();
    next();
  }
}

export function getStatus() {
  return { max: _max, count: _count, waiting: _waiters.length };
}

export function _reset() {
  _max = 2;
  _count = 0;
  _waiters.length = 0;
}
