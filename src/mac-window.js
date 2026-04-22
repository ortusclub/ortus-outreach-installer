/**
 * macOS AppleScript wrapper — minimize/un-minimize Chromium windows by PID.
 * Phase 11.2 (D-16, D-18). Best-effort: swallows errors, no-op on non-darwin.
 * See .planning/phases/11.2.../11.2-RESEARCH.md §Pattern 1 + §Pitfall 1.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const isDarwin = process.platform === 'darwin';
const realExecFile = promisify(execFileCb);

// Module-level indirection so tests can inject a mock. See _setExecFile.
let _execFile = realExecFile;

/**
 * Test hook — inject a replacement execFile(cmd, args, opts) -> Promise<{stdout,stderr}>.
 * Matches the convention used by resource-monitor._resetSampleCache and
 * campaign._setTestState. Pass null to restore the real /usr/bin/osascript invocation.
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
 * Minimize every window of the Chromium/Orbita process at the given PID.
 * Best-effort: never throws, no-op on non-darwin, 3s timeout, numeric-only PID.
 */
export async function minimizeByPid(pid) {
  if (!isDarwin) return;
  const n = coercePid(pid);
  if (!n) return;
  // `miniaturized` is read-only on System Events windows (error -10006).
  // The writable path is the AXMinimized accessibility attribute.
  // Repeat-until-window loop handles the compositor race: the process may
  // exist before its first window has drawn.
  const script = `
    tell application "System Events"
      tell (first process whose unix id is ${n})
        repeat 30 times
          if (count of windows) > 0 then exit repeat
          delay 0.1
        end repeat
        repeat with w in every window
          try
            set value of attribute "AXMinimized" of w to true
          end try
        end repeat
      end tell
    end tell
  `.trim();
  try {
    await _execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 });
  } catch (err) {
    console.warn(`[mac-window] minimizeByPid(${n}) failed: ${err.message || err}`);
  }
}

/**
 * Un-minimize every window for each PID. Returns a count summary.
 * No-op on non-darwin (returns { minimized: 0, skipped: 0 }).
 */
export async function unminimizeByPids(pids) {
  if (!isDarwin) return { minimized: 0, skipped: 0 };
  let minimized = 0;
  let skipped = 0;
  for (const pid of pids || []) {
    const n = coercePid(pid);
    if (!n) { skipped++; continue; }
    const script = `
      tell application "System Events"
        tell (first process whose unix id is ${n})
          repeat with w in every window
            try
              set value of attribute "AXMinimized" of w to false
            end try
          end repeat
          set frontmost to true
        end tell
      end tell
    `.trim();
    try {
      await _execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 });
      minimized++;
    } catch (err) {
      console.warn(`[mac-window] unminimize(${n}) failed: ${err.message || err}`);
      skipped++;
    }
  }
  return { minimized, skipped };
}
