/**
 * macOS AppleScript wrapper — hide/unhide Chromium processes by PID.
 * Phase 11.2 (D-16, D-18) + 260423-v40. Best-effort: swallows errors, no-op on non-darwin.
 *
 * Why "hide" and not "minimize": minimize has a race — the window must draw
 * at least one frame before AppleScript can act on it, which causes a brief
 * on-screen flash. Hide (Cmd+H equivalent) acts on the process, so it applies
 * before the first window draws — no flash. The dock icon stays visible.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const isDarwin = process.platform === 'darwin';
const realExecFile = promisify(execFileCb);

// Module-level indirection so tests can inject a mock. See _setExecFile.
let _execFile = realExecFile;

/**
 * Test hook — inject a replacement execFile(cmd, args, opts) -> Promise<{stdout,stderr}>.
 * Pass null to restore the real /usr/bin/osascript invocation.
 */
export function _setExecFile(fn) {
  _execFile = fn ?? realExecFile;
}

function coercePid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * Hide the process at the given PID (macOS Cmd+H equivalent).
 * Best-effort: never throws, no-op on non-darwin, 3s timeout, numeric-only PID.
 */
export async function hideByPid(pid) {
  if (!isDarwin) return;
  const n = coercePid(pid);
  if (!n) return;
  // System Events `set visible of process to false` is the scriptable form of
  // Cmd+H — applies to the process itself, not individual windows, so it works
  // even if the first window has not drawn yet. Dock icon stays.
  const script = `
    tell application "System Events"
      tell (first process whose unix id is ${n})
        set visible to false
      end tell
    end tell
  `.trim();
  try {
    await _execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 });
  } catch (err) {
    console.warn(`[mac-window] hideByPid(${n}) failed: ${err.message || err}`);
  }
}

/**
 * Un-hide every process in the PID list. Returns a count summary.
 * No-op on non-darwin (returns { shown: 0, skipped: 0 }).
 */
export async function unhideByPids(pids) {
  if (!isDarwin) return { shown: 0, skipped: 0 };
  let shown = 0;
  let skipped = 0;
  for (const pid of pids || []) {
    const n = coercePid(pid);
    if (!n) { skipped++; continue; }
    const script = `
      tell application "System Events"
        tell (first process whose unix id is ${n})
          set visible to true
          set frontmost to true
        end tell
      end tell
    `.trim();
    try {
      await _execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 });
      shown++;
    } catch (err) {
      console.warn(`[mac-window] unhide(${n}) failed: ${err.message || err}`);
      skipped++;
    }
  }
  return { shown, skipped };
}
