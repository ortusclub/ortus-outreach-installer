/**
 * Post Amplification engine — Phase 2 (v2.12.x).
 *
 * Per-account engagement on a single LinkedIn post URL. Each profile runs
 * sequentially (60–300s gap) so the post doesn't see synchronous bot-like
 * traffic. Within one account: 1–3s gaps between micro-actions and a 5–15s
 * dwell window so the impression registers naturally.
 *
 * Verified selectors (captured against live linkedin.com 2026-05):
 *   - Reaction button (default Like / dedup signal):
 *       button[aria-label^="Reaction button state:"]
 *       Examples:
 *         "Reaction button state: no reaction"  (unreacted)
 *         "Reaction button state: Like"         (already reacted as Like)
 *         "Reaction button state: Celebrate"    (already reacted as Celebrate)
 *   - Reactions menu trigger (no long-press needed — sibling button):
 *       button[aria-label="Open reactions menu"]
 *   - Reaction options (after picker opens) — naming convention inferred
 *     from LinkedIn's existing label scheme:
 *       button[aria-label="React Like|Celebrate|Support|Insightful|Funny|Love"]
 *   - Comment trigger:
 *       button[aria-label="Comment"]
 *   - Comment editor (Tiptap/ProseMirror, NOT Quill):
 *       div[role="textbox"][aria-label="Text editor for creating comment"]
 *   - Submit comment:
 *       button.comments-comment-box__submit-button
 *
 * Dedup state file: data/post-amplification-state.json
 *   { "<postUrl>": { "<profileId>": { reaction, commented, engagedAt } } }
 */

import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { launchProfile, closeProfile, getProfiles } from '../gologin-launcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// data/ dir resolution mirrors the rest of the codebase — env var override
// for packaged builds, else repo-relative.
const DATA_DIR = process.env.ORTUS_DATA_DIR || resolve(__dirname, '..', '..', 'data');
const STATE_FILE = join(DATA_DIR, 'post-amplification-state.json');

const REACTION_OPTIONS = ['Celebrate', 'Support', 'Insightful', 'Funny', 'Love'];

// 80% Like, 20% spread evenly across the other 5.
export function pickReaction() {
  if (Math.random() < 0.8) return 'Like';
  return REACTION_OPTIONS[Math.floor(Math.random() * REACTION_OPTIONS.length)];
}

function jitter(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Dedup state I/O ──────────────────────────────────────────────────────
export async function loadDedupState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Missing or unreadable — start empty. Phase 1 wrote {} as the scaffold.
    return {};
  }
}

export async function saveDedupState(state) {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[post-amp] could not persist dedup state: ${err.message}`);
  }
}

export function isAlreadyEngaged(state, postUrl, profileId) {
  return !!(state[postUrl] && state[postUrl][profileId]);
}

export function recordEngagement(state, postUrl, profileId, payload) {
  if (!state[postUrl]) state[postUrl] = {};
  state[postUrl][profileId] = { ...payload, engagedAt: Date.now() };
  return state;
}

// ─── DOM helpers (in-page primitives) ─────────────────────────────────────
// Find the reaction button currently rendered for the visible post. We scope
// to the document and trust that the operator landed on a single-post URL —
// LinkedIn renders the focused post above any "More posts from this author"
// recommendations, so the FIRST matching reaction button is ours.
async function getReactionButtonState(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('button[aria-label^="Reaction button state:"]');
    if (!btn) return { found: false };
    const label = btn.getAttribute('aria-label') || '';
    // "Reaction button state: no reaction" → unreacted
    // "Reaction button state: Like" / Celebrate / Support / Insightful / Funny / Love
    const m = label.match(/Reaction button state:\s*(.+)$/);
    const state = m ? m[1].trim() : '';
    return { found: true, state, alreadyReacted: state.toLowerCase() !== 'no reaction' };
  });
}

async function clickReactionButton(page) {
  // Default Like — single click.
  return page.evaluate(() => {
    const btn = document.querySelector('button[aria-label^="Reaction button state:"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
}

async function openReactionsMenu(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Open reactions menu"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
}

async function clickReactionOption(page, reactionName) {
  return page.evaluate((name) => {
    const sel = `button[aria-label="React ${name}"]`;
    const btn = document.querySelector(sel);
    if (!btn) return false;
    btn.click();
    return true;
  }, reactionName);
}

async function openCommentEditor(page) {
  return page.evaluate(() => {
    // Several LinkedIn variants — try aria-label first, then class.
    const candidates = [
      'button[aria-label="Comment"]',
      'button.comment-button',
      'button[aria-label*="comment" i][aria-label*="Comment" i]',
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); return true; }
    }
    return false;
  });
}

// ─── Core action ──────────────────────────────────────────────────────────
/**
 * Engage with a single post on a single profile.
 *
 * Returns:
 *   { ok: true, reaction, commented, alreadyReacted: false }
 *   { ok: true, alreadyReacted: true }                       — dedup hit
 *   { ok: false, error }                                     — failure
 */
export async function engagePost(page, postUrl, { reaction, commentText, log = () => {}, shouldAbort = () => false } = {}) {
  const reactionToUse = reaction || pickReaction();
  // Helper: return an abort result if the operator hit Stop. Sprinkled at
  // every major step boundary so /api/post-amplification/stop responds
  // within ~200ms instead of waiting for the entire engagePost flow.
  const abortIfRequested = () => shouldAbort()
    ? { ok: false, error: 'aborted by operator' }
    : null;
  // Chunked sleep — same total duration as plain sleep() but checks abort
  // every 200ms so dwell windows don't block stop for 15s.
  const abortableSleep = async (totalMs) => {
    const tick = 200;
    for (let elapsed = 0; elapsed < totalMs; elapsed += tick) {
      if (shouldAbort()) return false;
      await sleep(Math.min(tick, totalMs - elapsed));
    }
    return true;
  };

  if (abortIfRequested()) return abortIfRequested();
  log(`[post-amp] navigating to ${postUrl}`);

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    return { ok: false, error: `navigation failed: ${err.message}` };
  }
  if (abortIfRequested()) return abortIfRequested();

  // Checkpoint detection — LinkedIn redirects to /checkpoint/challenge/ on
  // suspicious activity. We don't try to solve it; just bail early so the
  // operator can intervene.
  const finalUrl = page.url();
  if (/\/checkpoint\//.test(finalUrl) || /\/uas\/login/.test(finalUrl) || /\/login/.test(finalUrl)) {
    return { ok: false, error: `account hit checkpoint/login redirect (${finalUrl})` };
  }

  // Wait for the reaction button to render. Strategy: poll up to 5 times with
  // a small scroll between attempts. LinkedIn lazy-mounts the social action
  // bar on intersection observer; if the post body is tall (carousel + long
  // copy + media) the bar can be off-screen at initial load and never mounts
  // until something scrolls it into view. We saw 2/3 accounts fail on a long
  // post in 2026-05-08 testing — a scroll-then-retry pattern fixes that and
  // is harmless when the bar was going to render anyway.
  const RETRY_ATTEMPTS = 5;
  let buttonFound = false;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS && !buttonFound; attempt++) {
    try {
      await page.waitForSelector('button[aria-label^="Reaction button state:"]', { timeout: 4000 });
      buttonFound = true;
      break;
    } catch { /* not yet — try scrolling */ }

    if (shouldAbort()) return { ok: false, error: 'aborted by operator' };
    // Scroll progressively further down on each retry to bring the action
    // bar into view (and trigger any lazy-mount observers).
    const scrollY = attempt * 600;
    log(`[post-amp] reaction button not yet rendered (attempt ${attempt}/${RETRY_ATTEMPTS}) — scrolling ${scrollY}px and retrying`);
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), scrollY).catch(() => {});
    await abortableSleep(800);
  }

  // Track whether we're on the picker-fallback path. When the primary
  // "Reaction button state:" selector is missing but the picker IS present
  // (seen on Robert's account 2026-05-08 — LinkedIn variant), use the picker
  // for reactions. Skip the in-page dedup check in that path; the local
  // state file remains the primary dedup mechanism.
  let usePickerFallback = false;

  if (!buttonFound) {
    // Diagnostic snapshot — capture WHY the button is missing.
    const diag = await page.evaluate(() => {
      const findText = (s) => Array.from(document.querySelectorAll('h1,h2,p,button,span'))
        .map(e => (e.textContent || '').trim())
        .find(t => t.toLowerCase().includes(s.toLowerCase())) || '';
      return {
        url: window.location.href,
        title: document.title || '',
        hasLoginForm: !!document.querySelector('input[type="password"]') ||
                      !!document.querySelector('input[name="session_password"]'),
        hasJoinCta: !!findText('Join now') || !!findText('Sign in') || !!findText('Sign up'),
        hasPostContainer: !!document.querySelector('div.feed-shared-update-v2, article, .fie-impression-container'),
        hasOpenReactionsMenu: !!document.querySelector('button[aria-label="Open reactions menu"]'),
        documentReadyState: document.readyState,
      };
    }).catch(() => ({ error: 'diagnostic snapshot failed' }));
    log(`[post-amp] DIAG ${JSON.stringify(diag)}`);

    if (diag.hasLoginForm || diag.hasJoinCta) {
      return { ok: false, error: `account is logged out (LinkedIn served the public/login page at ${diag.url})` };
    }
    if (!diag.hasPostContainer) {
      return { ok: false, error: `post body never rendered — post may be deleted, private, or geo-blocked (final url: ${diag.url})` };
    }
    if (diag.hasOpenReactionsMenu) {
      // Picker fallback path. Dump action-bar buttons so we eventually learn
      // the variant's primary Like-button selector for future direct clicks.
      const buttonsDump = await page.evaluate(() => {
        const trigger = document.querySelector('button[aria-label="Open reactions menu"]');
        if (!trigger) return [];
        // Climb to the action bar container — typically 2-3 levels up.
        let parent = trigger.parentElement;
        for (let i = 0; i < 4 && parent && parent.tagName !== 'BODY'; i++) {
          if (parent.querySelectorAll('button').length >= 3) break;
          parent = parent.parentElement;
        }
        if (!parent) return [];
        return Array.from(parent.querySelectorAll('button')).slice(0, 8).map(b => ({
          aria: (b.getAttribute('aria-label') || '').slice(0, 80),
          cls: (b.className || '').toString().slice(0, 80),
          txt: (b.textContent || '').trim().slice(0, 40),
        }));
      }).catch(() => []);
      log(`[post-amp] action-bar buttons: ${JSON.stringify(buttonsDump)}`);
      log(`[post-amp] using picker fallback (Open reactions menu present, default Like button selector failed to match)`);
      usePickerFallback = true;
    } else {
      return { ok: false, error: `reaction button never rendered after ${RETRY_ATTEMPTS} scroll-retries; post body present but neither the default Like button nor the reactions menu were found (final url: ${diag.url})` };
    }
  }

  // Scroll the relevant anchor into centre of viewport so impression tracking
  // counts a real view. Use whichever element we found.
  await page.evaluate((useFallback) => {
    const sel = useFallback
      ? 'button[aria-label="Open reactions menu"]'
      : 'button[aria-label^="Reaction button state:"]';
    const btn = document.querySelector(sel);
    if (btn) btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, usePickerFallback);
  const dwellMs = jitter(5000, 15000);
  log(`[post-amp] dwelling ${Math.round(dwellMs / 1000)}s`);
  const dwellOk = await abortableSleep(dwellMs);
  if (!dwellOk) return { ok: false, error: 'aborted by operator' };

  // Dedup gate: in the primary path, the "Reaction button state:" aria-label
  // tells us whether this account has already reacted. In the picker-fallback
  // path, we don't have that signal — fall through to local-state-only dedup
  // (already gated upstream in runAmplification).
  if (!usePickerFallback) {
    const initial = await getReactionButtonState(page);
    if (!initial.found) {
      return { ok: false, error: 'reaction button disappeared after dwell' };
    }
    if (initial.alreadyReacted) {
      log(`[post-amp] already reacted (${initial.state}) — skipping`);
      return { ok: true, alreadyReacted: true, reaction: initial.state, commented: false };
    }
  }

  // ─── React ──────────────────────────────────────────────────────────────
  let reactionApplied = '';

  if (usePickerFallback) {
    // Variant where the default Like-button selector is missing but the
    // reactions menu IS present — open the menu and click the chosen
    // reaction (or React Like if reactionToUse is 'Like').
    const opened = await openReactionsMenu(page);
    if (!opened) {
      return { ok: false, error: 'picker fallback: Open reactions menu suddenly missing' };
    }
    const target = reactionToUse || 'Like';
    try {
      await page.waitForSelector(`button[aria-label="React ${target}"]`, { timeout: 4000 });
    } catch {
      return { ok: false, error: `picker fallback: React ${target} option did not render after opening menu` };
    }
    const picked = await clickReactionOption(page, target);
    if (!picked) {
      return { ok: false, error: `picker fallback: React ${target} click failed` };
    }
    reactionApplied = target;
    await sleep(jitter(800, 1500));
  } else if (reactionToUse === 'Like') {
    const clicked = await clickReactionButton(page);
    if (!clicked) return { ok: false, error: 'Like button not clickable' };
    await sleep(jitter(800, 1500));
  } else {
    // Open the reactions menu, click the chosen reaction.
    const opened = await openReactionsMenu(page);
    if (!opened) {
      // Fallback: plain Like if the menu trigger isn't there.
      log(`[post-amp] reactions menu not found — falling back to Like`);
      const clicked = await clickReactionButton(page);
      if (!clicked) return { ok: false, error: 'reaction menu absent and Like fallback failed' };
    } else {
      // Wait briefly for the picker to render its options.
      try {
        await page.waitForSelector(`button[aria-label="React ${reactionToUse}"]`, { timeout: 4000 });
      } catch {
        // Picker opened but the option didn't render — fall back to Like.
        log(`[post-amp] React ${reactionToUse} option didn't render — falling back to Like`);
        await clickReactionButton(page).catch(() => {});
        reactionApplied = 'Like';
      }
      if (!reactionApplied) {
        const picked = await clickReactionOption(page, reactionToUse);
        if (!picked) {
          log(`[post-amp] React ${reactionToUse} click failed — falling back to Like`);
          await clickReactionButton(page).catch(() => {});
          reactionApplied = 'Like';
        }
      }
    }
    await sleep(jitter(800, 1500));
  }

  // Confirm the reaction stuck. Primary path reads "Reaction button state:";
  // picker-fallback path reads aria-pressed on the React-X buttons since the
  // primary state label isn't there.
  if (usePickerFallback) {
    const stuck = await page.evaluate((target) => {
      // After clicking React X, that button typically becomes aria-pressed=true.
      const btn = document.querySelector(`button[aria-label="React ${target}"]`);
      if (!btn) return false;
      return (btn.getAttribute('aria-pressed') || '').toLowerCase() === 'true';
    }, reactionApplied || reactionToUse || 'Like').catch(() => false);
    if (!stuck) {
      // Best-effort confirmation — not all LinkedIn variants set aria-pressed.
      // Don't fail the run; just log and continue.
      log(`[post-amp] picker fallback: could not confirm reaction stuck via aria-pressed (proceeding anyway)`);
    }
    log(`[post-amp] reacted (picker fallback): ${reactionApplied}`);
  } else {
    const after = await getReactionButtonState(page);
    if (after.found && after.alreadyReacted) {
      reactionApplied = reactionApplied || after.state || reactionToUse;
    } else {
      return { ok: false, error: 'reaction click did not register (state did not flip)' };
    }
    log(`[post-amp] reacted: ${reactionApplied}`);
  }

  // ─── Comment (optional) ─────────────────────────────────────────────────
  let commented = false;
  const text = (commentText || '').trim();
  if (text) {
    await sleep(jitter(1000, 3000));
    const opened = await openCommentEditor(page);
    if (!opened) {
      log(`[post-amp] could not open comment editor — skipping comment`);
    } else {
      try {
        // Wait for the Tiptap/ProseMirror editor to mount.
        await page.waitForSelector(
          'div[role="textbox"][aria-label="Text editor for creating comment"]',
          { timeout: 6000 }
        );
        // Focus the editor, then type via keyboard so LinkedIn's keystroke
        // listeners fire (page.type() doesn't work reliably on contenteditable).
        await page.click('div[role="textbox"][aria-label="Text editor for creating comment"]');
        await sleep(jitter(300, 700));
        await page.keyboard.type(text, { delay: jitter(50, 120) });
        await sleep(jitter(800, 1500));

        // Submit. The button is disabled until text is present, so wait for
        // its enabled state before clicking.
        const submitSelectors = [
          'button.comments-comment-box__submit-button:not([disabled])',
          'button[data-control-name="submit_comment"]:not([disabled])',
        ];
        let submitClicked = false;
        for (const sel of submitSelectors) {
          try {
            await page.waitForSelector(sel, { timeout: 3000 });
            await page.click(sel);
            submitClicked = true;
            break;
          } catch { /* try next */ }
        }
        if (submitClicked) {
          await sleep(jitter(1500, 2500));
          commented = true;
          log(`[post-amp] commented: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
        } else {
          log(`[post-amp] comment text typed but submit button never enabled — skipping`);
        }
      } catch (err) {
        log(`[post-amp] comment failed: ${err.message}`);
      }
    }
  }

  return {
    ok: true,
    alreadyReacted: false,
    reaction: reactionApplied,
    commented,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────
/**
 * Run the full amplification campaign.
 *
 * accountConfigs: [{ profileId, profileName, like, comment, commentText }]
 * status: shared object the server route pokes for live polling.
 */
export async function runAmplification({
  postUrl,
  accountConfigs,
  status,
  shouldAbort = () => false,
  log = () => {},
}) {
  if (!postUrl) throw new Error('postUrl required');
  if (!Array.isArray(accountConfigs) || accountConfigs.length === 0) {
    throw new Error('accountConfigs required');
  }

  const token = process.env.GOLOGIN_API_TOKEN;
  const dedup = await loadDedupState();

  status.total = accountConfigs.length;
  status.completed = 0;
  status.engaged = 0;
  status.skippedDedup = 0;
  status.errors = [];

  for (let i = 0; i < accountConfigs.length; i++) {
    if (shouldAbort()) {
      log(`[post-amp] aborted by operator at ${i}/${accountConfigs.length}`);
      break;
    }

    const cfg = accountConfigs[i];
    status.currentIndex = i + 1;
    status.currentProfile = cfg.profileName || cfg.profileId;

    // Dedup short-circuit — local state file. The in-page aria-label check
    // inside engagePost() is the second line of defence (catches the case
    // where the operator engaged via the LinkedIn UI manually).
    if (isAlreadyEngaged(dedup, postUrl, cfg.profileId)) {
      log(`[post-amp] ${cfg.profileName} already engaged with this post (state file) — skipping`);
      status.skippedDedup++;
      status.completed++;
      continue;
    }

    if (!cfg.like && !(cfg.comment && (cfg.commentText || '').trim())) {
      log(`[post-amp] ${cfg.profileName} has no actions configured — skipping`);
      status.completed++;
      continue;
    }

    log(`[post-amp] [${i + 1}/${accountConfigs.length}] ${cfg.profileName} starting…`);
    let session = null;
    try {
      session = await launchProfile(cfg.profileId, token);
      const reactionPlan = cfg.like ? pickReaction() : null;
      const commentPlan = (cfg.comment && (cfg.commentText || '').trim()) ? cfg.commentText.trim() : '';

      // If the operator unchecked Like but kept Comment, we still need to
      // open the post — but skip the reaction click. engagePost() handles
      // the case where reactionPlan is null by treating it as a no-op
      // reaction. Simpler: always pass a reaction; fall back to Like only
      // when commentPlan is set and like is unchecked. But the simplest
      // correct behaviour matching the operator intent: only engage if
      // like is checked OR commentPlan is non-empty (asserted above).
      // When like is unchecked, skip reactionPlan entirely.
      const result = await engagePost(session.page, postUrl, {
        reaction: cfg.like ? reactionPlan : null,
        commentText: commentPlan,
        log,
        shouldAbort,
      });

      if (result.ok) {
        if (result.alreadyReacted) {
          status.skippedDedup++;
          recordEngagement(dedup, postUrl, cfg.profileId, {
            reaction: result.reaction,
            commented: false,
            source: 'pre-existing',
          });
        } else {
          status.engaged++;
          recordEngagement(dedup, postUrl, cfg.profileId, {
            reaction: result.reaction,
            commented: result.commented,
            source: 'campaign',
          });
        }
        await saveDedupState(dedup);
      } else {
        status.errors.push(`[${cfg.profileName}] ${result.error}`);
        log(`[post-amp] ${cfg.profileName} failed: ${result.error}`);
      }
    } catch (err) {
      status.errors.push(`[${cfg.profileName}] ${err.message}`);
      log(`[post-amp] ${cfg.profileName} threw: ${err.message}`);
    } finally {
      // Always close the profile, even on error.
      try { await closeProfile(cfg.profileId); } catch { /* */ }
      status.completed++;
    }

    // Inter-account gap. Skip after the last one. Chunk at 200ms so an
    // operator's Stop press is honored within ~200ms instead of waiting up
    // to 2s as before.
    if (i < accountConfigs.length - 1 && !shouldAbort()) {
      const gapMs = jitter(60000, 300000);
      log(`[post-amp] sleeping ${Math.round(gapMs / 1000)}s before next account…`);
      const tick = 200;
      for (let elapsed = 0; elapsed < gapMs; elapsed += tick) {
        if (shouldAbort()) break;
        await sleep(Math.min(tick, gapMs - elapsed));
      }
    }
  }

  status.currentProfile = null;
  status.currentIndex = 0;
  return {
    engaged: status.engaged,
    skippedDedup: status.skippedDedup,
    errors: status.errors,
    total: status.total,
  };
}
