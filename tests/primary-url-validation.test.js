import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePrimaryUrl } from '../public/js/primary-url-validation.mjs';

test('blank is allowed (primary URL is optional) — ok with kind empty', () => {
  for (const v of ['', '   ', null, undefined]) {
    const r = validatePrimaryUrl(v);
    assert.equal(r.ok, true, `blank ${JSON.stringify(v)} should be ok`);
    assert.equal(r.kind, 'empty');
  }
});

test('valid personal /in/ profile URLs pass', () => {
  const good = [
    'https://www.linkedin.com/in/john-doe-123',
    'https://www.linkedin.com/in/john-doe-123/',
    'linkedin.com/in/johndoe',
    'www.linkedin.com/in/johndoe',
    'https://uk.linkedin.com/in/jane',
    'https://m.linkedin.com/in/jane',
    'https://www.linkedin.com/in/john?originalSubdomain=uk',
    'https://www.linkedin.com/in/john/detail/contact-info/',
    '  https://www.linkedin.com/in/john  ',
  ];
  for (const u of good) {
    const r = validatePrimaryUrl(u);
    assert.equal(r.ok, true, `expected OK for ${u} — got ${r.reason}`);
    assert.equal(r.kind, 'profile');
  }
});

test('encoded /in/ACwAA… profile URL passes (legit primary form)', () => {
  const r = validatePrimaryUrl('https://www.linkedin.com/in/ACwAABOTCAIBeECXSR8isLhdB1uuPP93vApGFUg');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.kind, 'profile');
});

test('LinkedIn non-profile pages are rejected with a specific reason', () => {
  const cases = [
    ['https://www.linkedin.com/company/acme', 'not-profile'],
    ['https://www.linkedin.com/company/acme/', 'not-profile'],
    ['https://www.linkedin.com/school/mit/', 'not-profile'],
    ['https://www.linkedin.com/feed/', 'not-profile'],
    ['https://www.linkedin.com/search/results/people/?keywords=x', 'not-profile'],
    ['https://www.linkedin.com/jobs/view/123', 'not-profile'],
    ['https://www.linkedin.com/in/', 'not-profile'],   // bare /in/ with no slug
    ['linkedin.com', 'not-profile'],                   // home page
  ];
  for (const [u, kind] of cases) {
    const r = validatePrimaryUrl(u);
    assert.equal(r.ok, false, `expected REJECT for ${u}`);
    assert.equal(r.kind, kind, `kind for ${u}`);
    assert.ok(r.reason && r.reason.length > 0, `reason for ${u}`);
  }
});

test('Sales Navigator links are rejected with a tailored message', () => {
  const r = validatePrimaryUrl('https://www.linkedin.com/sales/people/ACwAABabc,NAME_SEARCH');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'sales-nav');
  assert.match(r.reason, /sales navigator/i);
});

test('non-LinkedIn hosts are rejected (incl. look-alike spoof + typo)', () => {
  const cases = [
    'https://google.com/in/john',
    'https://mylinkedin.com/in/john',   // spoof: not a linkedin.com subdomain
    'https://www.linkdin.com/in/john',  // typo'd domain
  ];
  for (const u of cases) {
    const r = validatePrimaryUrl(u);
    assert.equal(r.ok, false, `expected REJECT for ${u}`);
    assert.equal(r.kind, 'not-linkedin');
  }
});

test('a name typed instead of a URL is rejected as not-a-url', () => {
  const r = validatePrimaryUrl('John Smith');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not-a-url');
});
