/**
 * Naming for the campaign that "Save edits & resume" actually produces.
 *
 * That button does not resume anything: server.js:2066 stops the original for
 * good and dispatches a NEW campaign with the leads that were still pending.
 * The name came from the wizard's own field, so the replacement inherited the
 * dead campaign's name unless the operator noticed and retyped it.
 *
 * Milee did this four times on one list — CC_I → CC_J → CC_K → CC_L — and read
 * a board filling with near-identical cards as the app creating campaigns by
 * itself. Suffixing the replacement is what makes the lineage legible.
 */

// "PRIMO_I CC_J (2)" → base "PRIMO_I CC_J", n 2. Trailing counter only.
const COUNTER = /^(.*?)\s*\((\d+)\)\s*$/;

/**
 * The next name in a replacement chain.
 * @param {string} name  the campaign being replaced
 * @returns {string} name + " (2)", or the counter incremented; '' for a blank name
 */
export function nextReplacementName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return ''; // nothing to build on — the caller keeps whatever the wizard holds
  const m = COUNTER.exec(s);
  if (!m) return `${s} (2)`;
  const base = m[1].trim();
  const n = parseInt(m[2], 10);
  // "(0)" / "(1)" are someone's own naming, not our chain — continue from 2.
  if (!base) return `${s} (2)`;
  return `${base} (${n >= 2 ? n + 1 : 2})`;
}
