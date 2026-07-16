// Pure schedule/decision logic for FG Auto-Pilot. No I/O — imported by both the
// desktop app (to render "next run") and the cloud roster service (to decide
// firing), so the two can never disagree. Timezone-correct via Intl.
const TZ = 'Europe/London';
const RUN_HOUR = 6; // 06:00 local — fixed in v1

// London date/time parts for an instant, as numbers.
function parts(date, tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const o = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  if (o.hour === 24) o.hour = 0; // some engines emit 24 for midnight
  return o; // { year, month, day, hour, minute }
}

export function cycleKey(date, tz = TZ) {
  const p = parts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function isRunDay(date, days = [1, 15], tz = TZ) {
  return days.includes(parts(date, tz).day);
}

// Build the UTC instant of RUN_HOUR:00 local on the given local Y-M-D. Corrects
// for the tz offset (incl. DST) with a single guess-and-fix pass.
function localRunInstant(year, month, day, tz = TZ) {
  const guess = Date.UTC(year, month - 1, day, RUN_HOUR, 0);
  const p = parts(new Date(guess), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = asUtc - guess; // ms the zone is ahead of UTC at that instant
  return new Date(guess - offset);
}

export function nextRun(now, { days = [1, 15], enabled = true } = {}, tz = TZ) {
  if (!enabled) return null;
  // Start from the London calendar day of now
  let p = parts(now, tz);
  let year = p.year;
  let month = p.month;
  let day = p.day;
  for (let i = 0; i < 400; i++) {
    if (days.includes(day)) {
      const instant = localRunInstant(year, month, day, tz);
      if (instant.getTime() > now.getTime()) return instant;
    }
    // Increment to next local calendar day (handles DST correctly)
    const nextDayUtc = new Date(Date.UTC(year, month - 1, day + 1));
    const nextP = parts(nextDayUtc, tz);
    year = nextP.year;
    month = nextP.month;
    day = nextP.day;
  }
  return null; // unreachable for sane inputs
}

export function shouldFire(now, config, ranCycleKeys = [], tz = TZ) {
  const key = cycleKey(now, tz);
  const c = config || {};
  if (!c.enabled) return { fire: false, reason: 'disabled', cycleKey: key };
  if (!Array.isArray(c.pairs) || !c.pairs.length) return { fire: false, reason: 'no-pairs', cycleKey: key };
  if (!isRunDay(now, c.days || [1, 15], tz)) return { fire: false, reason: 'not-a-run-day', cycleKey: key };
  if (ranCycleKeys.includes(key)) return { fire: false, reason: 'already-ran', cycleKey: key };
  return { fire: true, reason: 'fire', cycleKey: key };
}

export function fgCriteria(keywords = []) {
  return { jobTitles: Array.isArray(keywords) ? keywords : [], companies: [], geo: [] };
}

export function buildAutopilotConfig({
  pairs = [], keywords = [], enabled = true, days = [1, 15],
  marketerDefaults = [], publishedBy = '', publishedAt,
} = {}) {
  const cloudPairs = (pairs || [])
    .filter((p) => p && p.operator && p.account && p.profileId && p.profileId !== 'local-browser')
    .map((p) => ({ operator: p.operator, operatorName: p.operatorName || '', account: p.account, profileId: p.profileId }));
  const kw = Array.isArray(keywords) && keywords.length ? keywords : marketerDefaults;
  return { enabled, days, keywords: kw, pairs: cloudPairs, publishedBy, publishedAt };
}
