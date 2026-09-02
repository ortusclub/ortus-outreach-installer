/**
 * src/followup-dnc.js — should this follow-up go out on its own?
 *
 * A follow-up is a robot's second message into a thread. If the lead has
 * ALREADY written back, sending it regardless is the thing operators wince at:
 * "Hi James, just following up on the dinner" landing under James saying he
 * cannot come (Sam, 2026-09-02).
 *
 * THE RULE IS ANY REPLY, NOT A WORD LIST. A word list can always be outsmarted
 * by a decline nobody anticipated, and the cost of holding a warm reply is one
 * click while the cost of missing a decline is a message that should never have
 * been sent. So: the lead has written since the intro → hold it for the
 * operator. Silence → send as normal.
 *
 * The phrases below are NOT the hold rule. They only choose the WORDS on the
 * card, so an operator scanning it can tell "probable DNC" from "replied" and
 * deal with the declines first.
 */

// Apology-plus-refusal shapes, not single words. "sorry" alone is how people
// open a warm reply as often as a refusal.
const DECLINE_PHRASES = [
  /\b(can'?t|cannot|can not|won'?t be able|not able|unable) (to )?(make|attend|join|come|be there|do)\b/i,
  /\bhave to (pass|decline|miss)\b/i,
  /\bi'?ll (have to )?(pass|decline|sit this one out)\b/i,
  /\b(not|won'?t) be (attending|joining|coming)\b/i,
  /\bunfortunately i\b/i,
  /\b(maybe|perhaps) (another|next) time\b/i,
  /\bcatch (you|up) next time\b/i,
  /\bnot (the right|a good) (fit|time)\b/i,
  /\bno thank(s| you)\b/i,
  /\b(please )?(remove|take) me off\b/i,
  /\bnot interested\b/i,
];

/** The phrase that makes a reply read like a refusal, or null. Labelling only. */
export function declinePhrase(text) {
  const s = String(text || '');
  for (const re of DECLINE_PHRASES) {
    const m = re.exec(s);
    if (m) return m[0].trim();
  }
  return null;
}

/**
 * The lead's most recent message in the thread, or null when they have not
 * spoken. `messages` is [{ sender, text }] in thread order.
 *
 * Matched on the LEAD'S OWN NAME rather than on whichever CSS class LinkedIn
 * currently uses for "not mine". The task already stores leadName exactly, and
 * a name comparison survives a markup change that a class name would not.
 */
export function findLeadReply(messages, leadName) {
  const name = String(leadName || '').trim().toLowerCase();
  if (!name) return null;
  const first = name.split(/\s+/)[0];
  const mine = (messages || []).filter((m) => {
    const s = String((m && m.sender) || '').trim().toLowerCase();
    if (!s) return false;
    // Full name, or the first name alone — LinkedIn abbreviates in group threads.
    return s === name || s.split(/\s+/)[0] === first;
  });
  const last = mine[mine.length - 1];
  if (!last || !String(last.text || '').trim()) return null;
  return { sender: last.sender, text: String(last.text).trim() };
}

/**
 * The verdict for one thread. `null` means send it as normal.
 *
 * @returns {{reason:'declined'|'replied', phrase:string, quote:string, sender:string}|null}
 */
export function holdVerdict(messages, leadName) {
  const reply = findLeadReply(messages, leadName);
  if (!reply) return null;
  const phrase = declinePhrase(reply.text);
  return {
    reason: phrase ? 'declined' : 'replied',
    phrase: phrase || '',
    // Enough for the operator to recognise it on the card without opening
    // LinkedIn; the thread is one click away for the rest.
    quote: reply.text.replace(/\s+/g, ' ').slice(0, 240),
    sender: reply.sender,
  };
}

/** How the card says it: "2 probable DNC · 1 replied", or ''. */
export function heldSummary(tasks) {
  const held = (tasks || []).filter((t) => t && t.type === 'follow-up' && t.status === 'held');
  const dnc = held.filter((t) => t.heldReason === 'declined').length;
  const replied = held.length - dnc;
  const bits = [];
  if (dnc) bits.push(`${dnc} probable DNC`);
  if (replied) bits.push(`${replied} replied`);
  return bits.join(' · ');
}
