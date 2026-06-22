import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLeadCsv, HEADER } from '../../src/connections/export.js';

test('writes lead schema with resolved Primary and CSV-escaping', () => {
  const out = path.join(os.tmpdir(), `wr-${process.pid}.csv`);
  const rows = [{
    contact: { firstname: 'Elson', lastname: 'Chia', linkedinbio: 'https://www.linkedin.com/in/elson-chia',
      company: 'Fujitsu, Asia', jobtitle: 'Director', country: 'Singapore' },
    warmVia: ['bea.talusan@ortus.solutions'], hasWarm: true,
  }];
  writeLeadCsv(rows, out, { 'bea.talusan@ortus.solutions': { name: 'Bea Talusan', linkedinUrl: 'https://linkedin.com/in/beatalusan' } });
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.strictEqual(lines[0], HEADER.join(','));
  assert.ok(lines[1].includes('"Fujitsu, Asia"'));            // comma field quoted
  assert.ok(lines[1].includes('Bea Talusan'));                // Primary resolved
  assert.ok(lines[1].includes('https://linkedin.com/in/beatalusan')); // Primary URL
  fs.unlinkSync(out);
});
