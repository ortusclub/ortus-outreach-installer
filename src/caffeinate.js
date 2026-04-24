// Prevents macOS from sleeping (display, idle, disk, AC-power) while a
// long-running job holds the process active. Sleep detaches Chromium frames
// and orphans puppeteer sessions, which we cannot recover from mid-campaign.
//
// Darwin-only. No-op on other platforms.

import { spawn } from 'node:child_process';

let proc = null;

export function preventSleep(reason = 'job') {
  if (process.platform !== 'darwin') return;
  if (proc && proc.exitCode == null && !proc.killed) return; // already active

  try {
    proc = spawn('/usr/bin/caffeinate', ['-dims'], { stdio: 'ignore' });
    proc.once('exit', () => { proc = null; });
    proc.once('error', (err) => {
      console.warn(`[caffeinate] spawn error: ${err.message}`);
      proc = null;
    });
    console.log(`[caffeinate] sleep prevention active (${reason})`);
  } catch (err) {
    console.warn(`[caffeinate] failed to start: ${err.message}`);
    proc = null;
  }
}

export function allowSleep() {
  if (!proc) return;
  try {
    proc.kill('SIGTERM');
  } catch {}
  proc = null;
  console.log('[caffeinate] sleep prevention released');
}

// Clean up on server shutdown so caffeinate doesn't outlive its parent.
process.once('exit', () => {
  if (proc) { try { proc.kill('SIGTERM'); } catch {} }
});
