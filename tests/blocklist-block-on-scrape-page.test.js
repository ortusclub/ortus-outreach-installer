// The blocklist excludes people from Sales Nav scrapes, but the only place to
// edit it was section 2 of the CAMPAIGN wizard — a different page from the
// scraper. Measured in the running app on 2026-09-01 while on #/salesnav:
//
//   wizBlocklist:   zero size
//   section2:       hidden by css
//   fullPanelScrim: hidden by css
//   manageLink:     zero size
//
// Every entry point to a scrape feature was unreachable from the scrape screen.
// There is ONE list per machine (data/blocklist.json), so the fix is a second
// copy of the same block, driven by the same code, on the page that uses it.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const app = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');
const server = fs.readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');

test('the scrape setup has its own blocklist box', () => {
  const scrape = html.slice(html.indexOf('id="nav-scrape"'), html.indexOf('id="nav-message-only"'));
  assert.ok(scrape.includes('id="sn-bl-value"'), 'no blocklist input on the scrape page');
  assert.ok(scrape.includes('id="sn-bl-add"'), 'no Add button on the scrape page');
  assert.ok(scrape.includes('id="sn-bl-chips"'), 'nowhere to render the chips');
});

test('the campaign wizard keeps its box — this adds one, it does not move it', () => {
  assert.ok(html.includes('id="wiz-bl-value"'));
  assert.ok(html.includes('id="wiz-bl-add"'));
  assert.ok(html.includes('id="wiz-bl-chips"'));
});

test('both copies are found by the SAME class, so they share one code path', () => {
  const inputs = html.match(/class="wiz-bl-value"/g) || [];
  const adds = html.match(/class="btn btn-secondary btn-sm wiz-bl-add"/g) || [];
  const chips = html.match(/wiz-bl-chips/g) || [];
  assert.equal(inputs.length, 2, 'each copy needs the shared input class');
  assert.equal(adds.length, 2, 'each copy needs the shared button class');
  assert.ok(chips.length >= 2, 'each copy needs a chips host');
});

test('the renderer paints every copy, not just the first', () => {
  const fn = app.slice(app.indexOf('async function renderWizardBlocklist('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /querySelectorAll\('\.wiz-bl-chips'\)/, 'must select all hosts');
  assert.ok(!/getElementById\('wiz-bl-chips'\)/.test(body), 'must not target one host by id');
  assert.match(body, /hosts\.forEach/, 'must write into each host');
});

test('adding from either copy is wired, not just the wizard one', () => {
  assert.match(app, /querySelectorAll\('\.wiz-blocklist'\)\.forEach/,
    'every copy of the block must get its own add handler');
});

test('the list this edits is the one the scrape actually filters on', () => {
  // If these ever diverge, the box on the scrape page becomes decorative.
  const route = server.slice(server.indexOf("app.post('/api/scrape/start'"));
  const body = route.slice(0, 1200);
  assert.match(body, /readBlocklist\(\)/, 'the scrape must read the same list');
  assert.match(body, /excludeUrns/, 'and pass it to the engine');
});
