/**
 * src/resource-monitor.js — pure-ish sampling + throttle state machine.
 *
 * Purpose (phase 11.1):
 *  - sample(browserPids)            → numeric OS + per-PID snapshot (Node os + pidusage)
 *  - decideThrottle(state, sample, cfg) → pure hysteresis state machine (D-05/D-06/D-07)
 *  - computeDelayMultiplier({...})  → pure matrix helper (D-08) extracted from campaign.js:851
 *  - cfg / loadConfig()             → .env knobs with documented defaults (D-14)
 *
 * Callers:
 *  - src/campaign.js (round-robin loop) — calls sample() + decideThrottle() each iteration
 *  - src/campaign.js (checkHostHealth refactor) — calls sample([]) for the one-shot preflight
 *  - tests/* — import these pure functions and assert directly
 *
 * Non-goals:
 *  - No I/O to disk, no HTTP, no timers, no side effects outside the cached sample.
 *  - No log() calls — campaign.js translates samples/transitions into user-visible log lines.
 */

import os from 'node:os';
import pidusage from 'pidusage';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// macOS-only: os.freemem() counts only truly-free pages and ignores inactive
// and purgeable pages that the kernel will reclaim on demand. vm_stat gives
// the same breakdown Activity Monitor uses. Falls back to os.freemem() on
// parse failure.
async function readMacRamPct() {
  try {
    const { stdout } = await execFile('vm_stat');
    const pageSizeMatch = stdout.match(/page size of (\d+) bytes/);
    if (!pageSizeMatch) return null;
    const pageSize = Number(pageSizeMatch[1]);
    const rowOf = (name) => {
      const m = stdout.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    const free      = rowOf('Pages free');
    const inactive  = rowOf('Pages inactive');
    const purgeable = rowOf('Pages purgeable');
    const availableBytes = (free + inactive + purgeable) * pageSize;
    const totalBytes = os.totalmem();
    if (totalBytes <= 0) return null;
    return (1 - availableBytes / totalBytes) * 100;
  } catch {
    return null;
  }
}

// ── Config ────────────────────────────────────────────────────────────────
// Matches existing patterns: Number(x) || default keeps invalid/missing env
// from crashing the module (e.g. "not-a-number" → NaN → falsy → default).
export function loadConfig() {
  return {
    RAM_THROTTLE_PCT:         Number(process.env.RAM_THROTTLE_PCT)         || 90,
    RAM_RELEASE_PCT:          Number(process.env.RAM_RELEASE_PCT)          || 80,
    CPU_THROTTLE_LOAD_FACTOR: Number(process.env.CPU_THROTTLE_LOAD_FACTOR) || 0.9,
    CPU_RELEASE_LOAD_FACTOR:  Number(process.env.CPU_RELEASE_LOAD_FACTOR)  || 0.7,
    THROTTLE_MULTIPLIER:      Number(process.env.THROTTLE_MULTIPLIER)      || 2,
    PARK_PAGE:                process.env.PARK_PAGE                        || 'about:blank',
    IDLE_PARKING_ENABLED:     process.env.IDLE_PARKING_ENABLED !== 'false',
  };
}
export const cfg = loadConfig();

// ── Windows CPU% fallback (Pitfall 3) ─────────────────────────────────────
// On Windows os.loadavg() returns [0,0,0] by design. We approximate "load1"
// from os.cpus() delta-sampling so the same threshold (load1 > cpuCount*0.9) works.
let _prevCpuTimes = null;
function getCpuPct() {
  const cpus = os.cpus();
  const now  = cpus.map(c => ({
    idle:  c.times.idle,
    total: Object.values(c.times).reduce((a, b) => a + b, 0),
  }));
  if (!_prevCpuTimes) { _prevCpuTimes = now; return 0; }
  let idleDiff = 0, totalDiff = 0;
  for (let i = 0; i < now.length; i++) {
    idleDiff  += now[i].idle  - _prevCpuTimes[i].idle;
    totalDiff += now[i].total - _prevCpuTimes[i].total;
  }
  _prevCpuTimes = now;
  return totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
}

// ── Sample cache (Pitfall 5) ──────────────────────────────────────────────
// 5s TTL so fast campaigns (message_only with delayMin<5s) don't thrash
// pidusage. Module-level because sampling is cross-cutting across the
// campaign loop and preflight.
let _cachedSample = null;
const MIN_SAMPLE_INTERVAL_MS = 5000;

export async function sample(browserPids = []) {
  if (_cachedSample && Date.now() - _cachedSample.sampledAt < MIN_SAMPLE_INTERVAL_MS) {
    return _cachedSample;
  }

  const cpuCount  = os.cpus().length;
  const isWindows = process.platform === 'win32';
  const isMac     = process.platform === 'darwin';
  const cpuPct    = isWindows ? getCpuPct() : 0;
  const load1     = isWindows ? (cpuPct / 100) * cpuCount : os.loadavg()[0];
  const macRam    = isMac ? await readMacRamPct() : null;
  const ramPct    = macRam !== null ? macRam : (1 - os.freemem() / os.totalmem()) * 100;

  let pidStats = {};
  if (browserPids.length > 0) {
    try {
      pidStats = await pidusage(browserPids);
    } catch (err) {
      // Pitfall 2: a PID may have exited between samples. Swallow, return empty.
      console.warn(`[resource-monitor] pidusage failed: ${err.message}`);
    }
  }
  const browsers = browserPids
    .map(pid => ({ pid, rssMb: Math.round((pidStats[pid]?.memory ?? 0) / 1024 / 1024) }))
    .filter(b => b.rssMb > 0);
  const totalBrowserRssMb = browsers.reduce((a, b) => a + b.rssMb, 0);

  _cachedSample = {
    ramPct,
    load1,
    cpuPct,
    cpuCount,
    browsers,
    totalBrowserRssMb,
    sampledAt: Date.now(),
  };
  return _cachedSample;
}

// Test hook — clears the cache so sample() re-fetches immediately. Also clears
// the Windows CPU delta baseline so tests that swap platforms don't leak state.
export function _resetSampleCache() {
  _cachedSample = null;
  _prevCpuTimes = null;
}

// ── Pure hysteresis state machine (D-05/D-06/D-07) ────────────────────────
// Engage on RAM OR load above upper band; release only when BOTH below lower
// band; otherwise keep the prior state (hysteresis).
export function decideThrottle(state, smp, config) {
  const { ramPct, load1, cpuCount } = smp;
  const upperRam  = config.RAM_THROTTLE_PCT;
  const lowerRam  = config.RAM_RELEASE_PCT;
  const upperLoad = cpuCount * config.CPU_THROTTLE_LOAD_FACTOR;
  const lowerLoad = cpuCount * config.CPU_RELEASE_LOAD_FACTOR;

  const ramHigh  = ramPct > upperRam;
  const loadHigh = load1  > upperLoad;
  const ramLow   = ramPct < lowerRam;
  const loadLow  = load1  < lowerLoad;

  let active = state.active;
  if (!state.active && (ramHigh || loadHigh))     active = true;   // D-05 (OR to engage)
  else if (state.active && ramLow && loadLow)     active = false;  // D-06 (AND to release)
  // Between bands → keep prior state (hysteresis).

  const reasons = [];
  if (active && ramPct > lowerRam)  reasons.push(`RAM ${ramPct.toFixed(0)}%`);
  if (active && load1  > lowerLoad) reasons.push(`load1 ${load1.toFixed(1)}`);

  return {
    active,
    reason: reasons.join(' + '),
    multiplier: active ? config.THROTTLE_MULTIPLIER : 1,
  };
}

// ── Ambient sampling (always-on, independent of campaign state) ───────────
// Server-wide 5s interval so the dashboard tiles have live RAM/CPU data from
// the moment the app opens, not only while the round-robin loop is iterating.
// Idempotent: a second start() call is a no-op.
let _ambientSample = null;
let _ambientThrottle = null;
let _ambientInterval = null;

export function getAmbient() {
  return { sample: _ambientSample, throttle: _ambientThrottle };
}

export function startAmbientSampling(getBrowserPids = () => []) {
  if (_ambientInterval) return;
  const tick = async () => {
    try {
      const pids = (typeof getBrowserPids === 'function' ? getBrowserPids() : []) || [];
      const smp = await sample(pids);
      const prev = _ambientThrottle || { active: false, reason: '', multiplier: 1 };
      _ambientSample = smp;
      _ambientThrottle = decideThrottle(prev, smp, cfg);
    } catch {
      // Sampling must never crash the server. Swallow.
    }
  };
  tick();
  _ambientInterval = setInterval(tick, MIN_SAMPLE_INTERVAL_MS);
  if (_ambientInterval.unref) _ambientInterval.unref();
}

export function stopAmbientSampling() {
  if (_ambientInterval) {
    clearInterval(_ambientInterval);
    _ambientInterval = null;
  }
}

// ── Pure delay-multiplier matrix (D-08) ───────────────────────────────────
// Extracted from campaign.js:851 so the matrix is unit-testable.
// Preserves byte-identical behavior for existing cases: message_only → 1,
// single-profile connect/other → 2, multi-profile connect/other → 1. When
// throttleActive, multiplies by throttleMultiplier EXCEPT in message_only mode.
export function computeDelayMultiplier({ mode, profileCount, throttleActive, throttleMultiplier }) {
  if (mode === 'message_only') return 1;
  const single = profileCount === 1 ? 2.0 : 1.0;
  const thr = throttleActive ? throttleMultiplier : 1;
  return single * thr;
}
