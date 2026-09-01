import { test } from 'node:test';
import assert from 'node:assert';
import { plainLine } from '../src/log-voice.js';

const BANNED = [/Voyager/i, /pidMatched/, /\bStage\b/, /HTTP\s*4\d\d/, /profileId/, /—/];

test('a sweep that found nobody says so in words, not counters', () => {
  const s = plainLine('sweep-empty', { account: 'camillec@ortus.solutions', outstanding: 31 });
  assert.match(s, /nobody has accepted/i);
  assert.ok(!/scanned=/.test(s), 'no field dumps');
});

test('a rate limit is described by what it means, not by its status code', () => {
  const s = plainLine('rate-limited', { account: 'camillec@ortus.solutions', waitMin: 12 });
  assert.ok(!/429/.test(s), 'the operator does not know what a 429 is');
  assert.match(s, /LinkedIn/);
});

test('no line contains an internal name, a field dump or an em dash', () => {
  const kinds = ['sweep-empty', 'sweep-found', 'rate-limited', 'sent', 'skipped', 'turn-start', 'turn-end', 'check-stopped'];
  for (const k of kinds) {
    const s = plainLine(k, {
      account: 'a@b.c', who: 'Rina Chandran', outstanding: 3, accepted: 1,
      waitMin: 5, done: 8, size: 8, why: 'no LinkedIn link on the row',
    });
    for (const re of BANNED) assert.ok(!re.test(s), `${k} contains ${re}: ${s}`);
    assert.ok(s.length > 20, `${k} is too terse to read out loud: ${s}`);
    assert.ok(!/[A-Za-z]+=/.test(s), `${k} carries a key=value pair: ${s}`);
  }
});

test('a sent line names the person, not just a count', () => {
  const s = plainLine('sent', { account: 'a@b.c', who: 'Rina Chandran', done: 6, size: 8 });
  assert.match(s, /Rina Chandran/);
});

test('an unknown kind stays silent rather than saying something wrong', () => {
  assert.strictEqual(plainLine('no-such-kind', { account: 'a@b.c' }), '');
});
