/**
 * Reply auto-classification — pure keyword/heuristic playbook (NO AI, works
 * offline). Labels a lead's inbound reply so the Replies inbox can sort
 * "interested" to the top and flag soft declines for review.
 *
 * Categories (approved in public/sketches/reply-inbox-B.html +
 * master-all-features.html): interested / not-interested / out-of-office /
 * question / other. Each result carries a confidence: 'high' renders as a
 * solid chip, 'low' renders as a dashed "· check" chip the operator should
 * eyeball and can correct via the label menu.
 */

export const REPLY_CATEGORIES = Object.freeze([
  'interested', 'not-interested', 'out-of-office', 'question', 'other',
]);

export const CATEGORY_LABELS = Object.freeze({
  'interested': 'Interested',
  'not-interested': 'Not interested',
  'out-of-office': 'Out of office',
  'question': 'Question',
  'other': 'Other',
});

// ── pattern tables ──────────────────────────────────────────────────────────
// Order matters: OOO first (auto-replies often contain "please contact"),
// then explicit declines (which may contain the word "interested"), then
// positive signals, then question shapes.

const OOO_STRONG = [
  /\bout of (the )?office\b/i,
  /\bon (annual|parental|maternity|paternity|sick) leave\b/i,
  /\bon leave until\b/i,
  /\blimited access to (my )?(email|e-mail|linkedin|messages)\b/i,
  /\bauto[- ]?reply\b/i,
  /\baway (from (my )?desk|on holiday|on vacation|until)\b/i,
  /\bcurrently (travelling|traveling|on holiday|on vacation)\b/i,
  /\breturning (to the office )?on\b/i,
  /\bback in the office\b/i,
  /\bplease contact my (ea|pa|assistant|colleague)\b/i,
];

const NOT_INTERESTED_STRONG = [
  /\bnot interested\b/i,
  /\bno,? thank(s| you)\b/i,
  /\bnot (for|a fit for) (me|us)\b/i,
  /\bnot relevant\b/i,
  /\bplease (remove me|take me off|stop (messaging|contacting|emailing))\b/i,
  /\bunsubscribe\b/i,
  /\bdon'?t contact me\b/i,
  /\bwe('re| are) (all set|not looking)\b/i,
  /\bnot the right (person|time|fit)\b/i,
];

// Soft declines — "pass for now / revisit later" language. These classify as
// not-interested but at LOW confidence (the sketch's dashed "· check" chip):
// the lead may actually be a deferred yes.
const NOT_INTERESTED_SOFT = [
  /\b(have to|going to|i'?ll|will) pass\b/i,
  /\bpass on (this|anything|it)\b/i,
  /\bnot (right now|at (the|this) (moment|time))\b/i,
  /\bmaybe (later|another time|next time)\b/i,
  /\b(revisit|circle back|reconnect|follow up) (in|later|next|after)\b/i,
  /\bbad timing\b/i,
  /\btiming (isn'?t|is not) (great|right|good)\b/i,
];

const INTERESTED_STRONG = [
  /\bsounds (great|good|interesting|perfect|fantastic)\b/i,
  /\bhappy to (join|attend|come|take part|participate)\b/i,
  /\b(i'?m|count me) in\b/i,
  /\bwould love to (join|attend|come|be there|take part)\b/i,
  /\bsign me up\b/i,
  /\b(very|definitely|certainly) interested\b/i,
  /\bi('?m| am) interested\b/i,
  /\bsend (over|me|through) the (date|details|invite|invitation|agenda|guest list|link)\b/i,
  /\bplease (send|share) (the|more) (details|info|information|invite|agenda)\b/i,
  /\bcheck my (calendar|diary|schedule)\b/i,
  /\blook(s)? forward to (it|joining|attending)\b/i,
  /\byes[,!. —-]/i,
  /^yes\b/i,
];

const INTERESTED_SOFT = [
  /\binterested\b/i,          // bare "interested" with no negation caught above
  /\btell me more\b/i,
  /\bmore (details|info|information)\b/i,
  /\bkeen\b/i,
  /\bopen to (it|this|that|learning more)\b/i,
];

const QUESTION_STRONG = [
  /\bwhat('?s| is) the (format|agenda|cost|price|date|catch)\b/i,
  /\bwho else (is|will be)\b/i,
  /\bis (this|it) (a )?(sales pitch|sponsored|free|paid)\b/i,
  /\bhow (much|long|many|does)\b/i,
  /\b(when|where) (is|will) (it|this)\b/i,
  /\bcould you (tell|explain|clarify)\b/i,
];

function hitAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * Classify one reply text. Pure, deterministic, offline.
 * @param {string} text
 * @returns {{ category: string, label: string, confidence: 'high'|'low' }}
 */
export function classifyReply(text) {
  const t = String(text || '').trim();
  const done = (category, confidence) => ({ category, label: CATEGORY_LABELS[category], confidence });
  if (!t) return done('other', 'low');

  // 1. Out-of-office auto-replies (checked first: they often contain polite
  //    filler that would otherwise read as interest or a question).
  if (hitAny(OOO_STRONG, t)) return done('out-of-office', 'high');

  // 2. Explicit declines beat everything else ("not interested" contains
  //    "interested").
  if (hitAny(NOT_INTERESTED_STRONG, t)) return done('not-interested', 'high');

  // 3. Positive signals.
  if (hitAny(INTERESTED_STRONG, t)) return done('interested', 'high');

  // 4. Soft declines — low confidence, dashed "check" chip.
  if (hitAny(NOT_INTERESTED_SOFT, t)) return done('not-interested', 'low');

  // 5. Question shapes: known question phrasings, or any text that ends in a
  //    question mark.
  if (hitAny(QUESTION_STRONG, t)) return done('question', 'high');
  if (/\?\s*["'”’]?\s*$/.test(t) || t.includes('?')) return done('question', 'low');

  // 6. Weak positive hints, only after negations/questions are ruled out.
  if (hitAny(INTERESTED_SOFT, t)) return done('interested', 'low');

  return done('other', 'low');
}

/** True when a label string is one of the approved display labels. */
export function isValidLabel(label) {
  return Object.values(CATEGORY_LABELS).includes(label);
}
