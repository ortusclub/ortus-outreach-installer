// Operator ask, 2026-08-27: "when i type the name of the primary it remembers
// the url of the linkedin". The list is derived from the cloud launch-config
// snapshots the app already writes on every dispatch, so there is no second
// store to keep in sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listPrimaryPeople } from '../src/cloud-launch-configs.js';

const entry = (ts, primaryName, primaryUrl) => ({
  name: 'a campaign', ts, config: { mode: 'connect_and_introduce', templates: { primaryName, primaryUrl } },
});

test('one person used many times is one entry, newest first', () => {
  const out = listPrimaryPeople({
    a: entry(300, 'Antonio Varlese', 'https://www.linkedin.com/in/antoniovarlese/'),
    b: entry(100, 'Antonio Varlese', 'https://www.linkedin.com/in/antoniovarlese/'),
    c: entry(200, 'Sam Adcock', 'https://www.linkedin.com/in/sam-adcock'),
  });
  assert.deepEqual(out.map((p) => [p.name, p.count]), [['Antonio Varlese', 2], ['Sam Adcock', 1]]);
});

test('identity is the URL, so a renamed person does not split in two', () => {
  const out = listPrimaryPeople({
    a: entry(100, 'Sam', 'https://www.linkedin.com/in/sam-adcock'),
    b: entry(200, 'Sam Adcock', 'https://www.linkedin.com/in/sam-adcock/'),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 2);
  assert.equal(out[0].name, 'Sam Adcock', 'the most recent spelling wins');
  assert.equal(out[0].url, 'https://www.linkedin.com/in/sam-adcock/', 'and its exact URL');
});

test('two people sharing a first name stay separate', () => {
  const out = listPrimaryPeople({
    a: entry(200, 'Sam', 'https://www.linkedin.com/in/sam-adcock'),
    b: entry(100, 'Sam', 'https://www.linkedin.com/in/sam-reid'),
  });
  assert.equal(out.length, 2);
});

test('an entry that would recall nothing is dropped', () => {
  const out = listPrimaryPeople({
    a: entry(100, 'No URL', ''),
    b: entry(200, '', 'https://www.linkedin.com/in/no-name'),
    c: { ts: 300, config: {} },
    d: { ts: 400 },
  });
  assert.deepEqual(out, []);
});

test('an empty or missing store answers with an empty list', () => {
  assert.deepEqual(listPrimaryPeople({}), []);
  assert.deepEqual(listPrimaryPeople(), []);
});
