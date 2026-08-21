/**
 * The operator's voice.
 *
 * Every line the operator reads should be a sentence they could say out loud
 * to a colleague. No counters on their own, no field names, no identifiers,
 * no status codes. The account is named by its email, the person by their
 * name, and anything that went wrong is described by what it MEANS, not by
 * what the code called it.
 *
 * This module only builds strings. It reads nothing and writes nothing, so a
 * wording change can never change what a campaign does.
 */

/** "camillec@ortus.solutions" -> "camillec@ortus.solutions'" (or "'s"). */
function poss(name) {
  const s = String(name || 'this account');
  return /s$/i.test(s) ? `${s}'` : `${s}'s`;
}

function plural(n, one, many) {
  return Number(n) === 1 ? one : many;
}

/** A reason fragment, as the first half of a sentence: capitalised, one dot. */
function sentence(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const capped = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

const BUILDERS = {
  /** A sweep that found nobody new. */
  'sweep-empty'({ account, outstanding = 0, refreshed = 0, nextCheck = '' }) {
    const parts = [
      `🛏 Nobody has accepted ${poss(account)} ${outstanding} outstanding `
      + `${plural(outstanding, 'invitation', 'invitations')} yet.`,
    ];
    if (refreshed > 0) {
      parts.push(`${refreshed} ${plural(refreshed, 'row', 'rows')} refreshed as still waiting.`);
    }
    if (nextCheck) parts.push(`Checking again at ${nextCheck}.`);
    return parts.join(' ');
  },

  /** A sweep that found at least one new acceptance. */
  'sweep-found'({ account, accepted = 0, outstanding = 0, refreshed = 0, nextCheck = '' }) {
    const parts = [
      `🎉 ${accepted} ${plural(accepted, 'person', 'people')} accepted `
      + `${poss(account)} invitation out of ${outstanding} still waiting for an answer.`,
    ];
    if (refreshed > 0) {
      parts.push(`${refreshed} ${plural(refreshed, 'row', 'rows')} refreshed as still waiting.`);
    }
    if (nextCheck) parts.push(`Checking again at ${nextCheck}.`);
    return parts.join(' ');
  },

  /** LinkedIn told this account to back off for a while. */
  'rate-limited'({ account, waitMin = 0 }) {
    const wait = waitMin > 0
      ? `Waiting about ${waitMin} ${plural(waitMin, 'minute', 'minutes')}, then carrying on by itself.`
      : 'Waiting a while, then carrying on by itself.';
    return `⏸ LinkedIn is asking ${account} to slow down. ${wait} Nothing is lost.`;
  },

  /** One person was actually written to. */
  sent({ account, who, what = 'a connection request', done = 0, size = null, today = null, dailyLimit = null }) {
    const parts = [`✉ ${who} got ${what} from ${account}.`];
    const where = [];
    if (size) where.push(`${done} of this turn of ${size}`);
    if (today && dailyLimit) where.push(`${today} of the ${dailyLimit} this account can send today`);
    if (where.length) parts.push(`That is ${where.join(', and ')}.`);
    return parts.join(' ');
  },

  /** One person was passed over, and why, in words. */
  skipped({ account, who, why = '' }) {
    const head = `↷ Nothing was sent to ${who || 'this person'} from ${account}.`;
    const tail = sentence(why) || 'Something on their profile stopped it.';
    return `${head} ${tail}`;
  },

  /** An account picks up the rotation. */
  'turn-start'({ account, size = null }) {
    return size
      ? `▶ ${account} is taking its turn, up to ${size} ${plural(size, 'person', 'people')} this time round.`
      : `▶ ${account} is taking its turn and will work through everyone left on its list.`;
  },

  /** An account hands the rotation on. */
  'turn-end'({ account, sent = 0, size = null }) {
    const reached = `${sent} ${plural(sent, 'person', 'people')}`;
    return size
      ? `⏹ ${account} finished its turn, ${reached} reached out of the ${size} it was given. Handing over to the next account.`
      : `⏹ ${account} finished its turn, ${reached} reached. Handing over to the next account.`;
  },

  /** A check that did not get to the end. */
  'check-stopped'({ account, why = '' }) {
    const tail = sentence(why) || 'It picks up again on the next check, and nothing is lost.';
    return `■ The check for ${account} stopped before it finished. ${tail}`;
  },
};

/**
 * One operator-readable sentence.
 *
 * @param {string} kind  one of the keys above
 * @param {object} fields  whatever that kind needs; missing parts are dropped
 * @returns {string} a sentence, or '' for a kind nobody has words for yet
 */
export function plainLine(kind, fields = {}) {
  const build = BUILDERS[kind];
  if (!build) return '';
  const account = fields.account || 'this account';
  try {
    return build({ ...fields, account });
  } catch {
    return '';
  }
}

export default plainLine;
