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
//
// A group that cost people leads with that number instead of its tally. The
// card used to read "31 problems" when 30 of them lost nobody and the 31st
// silently dropped 61 people — the count of lines was never the severity.
const problemLine = (p) => (p.people
  ? `${n(p.people)} ${p.people === 1 ? 'person' : 'people'} NOT written — ${p.what} — ${p.fix}`
  // "nothing was lost" is the whole difference between the two kinds, and the
  // card is where it is read. Only say it where the distinction was computed —
  // `blocking` is absent on the collect and check groups this also renders.
  : `${n(p.count)} × ${p.what}${p.blocking === false ? ' — nothing was lost' : ''} — ${p.fix}`);

// Import groups sort worst-first out of summariseProblems; keep that order and
// state the cost before anything that cost nothing.
const importLines = (imp) => ((imp && imp.problems) || []).map(problemLine);

// "168 added · 200 updated" on a run that dropped 61 people is a true sentence
// that reads as a clean one. The loss belongs in the headline or nowhere.
const writeSummary = (imp, tail = '') => `${n(imp.created)} added · ${n(imp.updated)} updated`
  + (imp.notWritten ? ` · ${n(imp.notWritten)} NOT written` : '') + tail;

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
    const partial = s.imported;
    // A failed import has usually already written thousands of contacts, and
    // HubSpot cannot take them back. Say what got in before saying what broke.
    const summary = partial
      ? writeSummary(partial, ` before it stopped — ${s.error || 'it stopped unexpectedly'}`)
      : String(s.error || 'It stopped unexpectedly');
    return { ok: false, summary, problems: importLines(partial) };
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
    // Said once, or not at all. The check counts everyone HubSpot holds twice;
    // the import counts the subset whose second record refused the LinkedIn
    // address. Both are true and they are different numbers, so shown together
    // they read as a contradiction — "34 people are in HubSpot more than once"
    // directly above "30 × This person is in HubSpot twice". Once an import has
    // run, its line carries the same fact AND the fix, so this one stands down.
    const dupes = (pv.duplicates || []).length;
    const importSaidIt = ((s.imported && s.imported.problems) || [])
      .some((p) => p.code === 'duplicate_contact');
    if (dupes && !importSaidIt) {
      problems.push(`${n(dupes)} ${dupes === 1 ? 'person is' : 'people are'} in HubSpot more than once — `
        + 'their connection was recorded on the record with a real email address, so nothing was missed');
    }
    const blocked = pv.blocked || [];
    if (blocked.length) {
      problems.push(`${blocked.length} account${blocked.length === 1 ? '' : 's'} skipped: `
        + `${blocked.join(', ')} ${blocked.length === 1 ? 'isn’t' : 'aren’t'} on the HubSpot list yet`);
    }
  }

  // Import problems, already grouped by cause with a fix attached. Anything
  // that cost people goes to the TOP of the whole list, above the collect and
  // check findings — it is the only kind that means work was lost.
  const imp = s.imported;
  const groups = (imp && imp.problems) || [];
  problems.unshift(...groups.filter((p) => p.blocking).map(problemLine));
  problems.push(...groups.filter((p) => !p.blocking).map(problemLine));

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
    return { ok: !imp.notWritten, summary: writeSummary(imp), problems };
  }
  if (pv) {
    // A Check with nothing it is allowed to look at is not a Check that found
    // nothing. "0 new · 0 already there" reads as "we looked, they're all
    // known" — the opposite of the truth, which is that the sweep never opened
    // a single file. Operator screenshot 2026-08-12: that headline sat above a
    // card showing 27 people collected, with all four accounts skipped.
    // `read` is the accounts that had a file with rows in it. `accounts` is
    // only what HubSpot allowed — an allowed account that was never collected
    // reads as zero rows and would otherwise be counted as "looked at".
    const allowed = (pv.accounts || []).length;
    const looked = (pv.read || []).length;
    const skipped = (pv.blocked || []).length;
    if (!looked) {
      // Two different reasons to have looked at nothing, and the fix differs:
      // put the account on the HubSpot list, or go and collect it first.
      let why;
      if (!allowed && skipped) {
        why = `none of the ${n(skipped)} account${skipped === 1 ? '' : 's'} you picked is on the HubSpot list yet`;
      } else if (allowed) {
        why = `nothing has been collected yet for the ${n(allowed)} account${allowed === 1 ? '' : 's'} that could be checked`;
      } else {
        why = 'no accounts were picked';
      }
      return { ok: false, summary: `Nothing was checked — ${why}`, problems };
    }
    const t = pv.totals || {};
    // "Already there" is everyone HubSpot already holds, not the subset that
    // needed a property written. A contact that is already complete produces
    // no update at all, so counting updates hid them entirely.
    return { ok: true, summary: `${n(t.created)} new · ${n(t.existing)} already there`, problems };
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
