// The RUNNING ON control told the operator a cloud campaign was on their Mac.
//
// COLL_CHI_ANTONIO2 (engine id e4f26bc2-cec9-44a7-8b07-c89e1876215c) sat in
// `monitoring` on the VM from 28 August to 1 September. Its engine row, read
// live out of the running app, is:
//
//   { id, name, status: 'monitoring', monitorState: 'monitoring' }
//
// No `runsOn`. No `_cloud`. No `handoverAt`. _whSide's old last line was
//   return (status && status._cloud) ? 'vm' : 'local';
// so it returned 'local', the "This Mac" button lit up, and the operator
// reasonably read that as a completed switch. Nothing had ever switched — the
// campaign log holds zero handover records for that id.
//
// A default that invents an answer is worse than no answer, because nothing
// downstream can tell the invention from a fact.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');

function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in app.js`);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const _whSide = new Function(`${lift('_whSide')}; return _whSide;`)();

test('an explicit runsOn is always obeyed', () => {
  assert.equal(_whSide({ runsOn: 'vm' }), 'vm');
  assert.equal(_whSide({ runsOn: 'local' }), 'local');
  assert.equal(_whSide({ runsOn: 'VM' }), 'vm', 'case must not matter');
});

test('a campaign the app built from cloud data is on the VM', () => {
  assert.equal(_whSide({ _cloud: true }), 'vm');
});

test('runsOn wins over _cloud — a moved campaign is where it was moved to', () => {
  assert.equal(_whSide({ runsOn: 'local', _cloud: true }), 'local');
});

test('the real COLL_CHI_ANTONIO2 row is NOT reported as This Mac', () => {
  // Verbatim shape read out of the running app on 2026-09-01.
  const row = { id: 'e4f26bc2-cec9-44a7-8b07-c89e1876215c', name: 'COLL_CHI_ANTONIO2',
    status: 'monitoring', monitorState: 'monitoring' };
  assert.notEqual(_whSide(row), 'local', 'this is the four-day lie');
  assert.equal(_whSide(row), 'unknown');
});

test('no information at all is "unknown", never a machine', () => {
  for (const empty of [{}, null, undefined, { runsOn: '' }, { _cloud: false }]) {
    assert.equal(_whSide(empty), 'unknown', `${JSON.stringify(empty)} must not name a machine`);
  }
});
