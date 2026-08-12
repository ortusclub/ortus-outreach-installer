// What a finished Magellan run has to say for itself.
//
// The card used to keep its live counters after a run ended, so a finished
// Check read "92% · 0 people so far" — the live labels were still in place
// because nothing replaced them. This turns an ended run into one sentence and
// a short list of things worth knowing, in the words of whoever has to act on
// them.
//
// Pure. Takes the state, returns a record. Never reads the clock, never fetches.
import { summarise } from './magellan-diagnose.js';

const n = (v) => Number(v || 0).toLocaleString('en-US');

// One line per KIND of problem, never per occurrence: 61 identical duplicate
// clashes are one job, not 61 lines. Both group-by-cause helpers in this folder
// already return {count, what, fix}, so they render the same way.
const problemLine = (p) => `${n(p.count)} × ${p.what} — ${p.fix}`;

/**
 * @param {object} state - magellan-run.js getState() shape
 * @returns {{ok: boolean, summary: string, problems: string[]}|null}
 *   null while the run has not ended — there is nothing truthful to say yet.
 */
export function buildOutcome(state = {}) {
  const s = state || {};
  if (s.running) return null;
  if (!['done', 'stopped', 'error'].includes(s.phase)) return null;

  if (s.phase === 'error') {
    return { ok: false, summary: String(s.error || 'It stopped unexpectedly'), problems: [] };
  }

  const problems = [];

  // Collect failures — grouped by the diagnosis code the sweep already stamped.
  for (const g of summarise(s.perAccount || [])) {
    problems.push(problemLine({ count: g.count, what: g.what || 'It failed', fix: g.fix || '' }));
  }

  // Check findings. Duplicates are stated, never actioned: the import already
  // writes the connection to the record with a real email address, so there is
  // nothing to fix here — merging was dropped on purpose.
  const pv = s.preview;
  if (pv) {
    const dupes = (pv.duplicates || []).length;
    if (dupes) {
      problems.push(`${n(dupes)} ${dupes === 1 ? 'person is' : 'people are'} in HubSpot more than once — `
        + 'their connection was recorded on the record with a real email address, so nothing was missed');
    }
    const blocked = pv.blocked || [];
    if (blocked.length) {
      problems.push(`${blocked.length} account${blocked.length === 1 ? '' : 's'} skipped: `
        + `${blocked.join(', ')} ${blocked.length === 1 ? 'isn’t' : 'aren’t'} on the HubSpot list yet`);
    }
  }

  // Import problems, already grouped by cause with a fix attached.
  const imp = s.imported;
  for (const p of (imp && imp.problems) || []) problems.push(problemLine(p));

  // A run that ended early says how far it got BEFORE it states any total. A
  // partial number is never presented as a final one.
  if (s.phase === 'stopped') {
    return {
      ok: false,
      summary: `Stopped after ${n(s.done)} of ${n(s.total)} accounts — the rest weren’t asked about`,
      problems,
    };
  }

  // Which half ran decides which numbers mean anything. Newest wins: an import
  // replaces a check's summary, a check replaces a collect's.
  if (imp) {
    return { ok: true, summary: `${n(imp.created)} added · ${n(imp.updated)} updated`, problems };
  }
  if (pv) {
    // A Check with nothing it is allowed to look at is not a Check that found
    // nothing. "0 new · 0 already there" reads as "we looked, they're all
    // known" — the opposite of the truth, which is that the sweep never opened
    // a single file. Operator screenshot 2026-08-12: that headline sat above a
    // card showing 27 people collected, with all four accounts skipped.
    const looked = (pv.accounts || []).length;
    const skipped = (pv.blocked || []).length;
    if (!looked) {
      // Nothing was looked at, so every account picked was a skipped one.
      return {
        ok: false,
        summary: skipped
          ? `Nothing was checked — none of the ${n(skipped)} account${skipped === 1 ? '' : 's'} `
            + 'you picked is on the HubSpot list yet'
          : 'Nothing was checked — no accounts were picked',
        problems,
      };
    }
    const t = pv.totals || {};
    return { ok: true, summary: `${n(t.created)} new · ${n(t.updated)} already there`, problems };
  }
  const ok = (s.perAccount || []).filter((a) => !a.error);
  const people = ok.reduce((sum, a) => sum + (a.total || 0), 0);
  const matched = ok.reduce((sum, a) => sum + (a.withMemberId || 0), 0);
  return {
    ok: true,
    summary: `${n(people)} people from ${n(ok.length)} account${ok.length === 1 ? '' : 's'} · ${n(matched)} with a LinkedIn ID`,
    problems,
  };
}
