import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/reply-suggest.js';

test('buildPrompt includes the lead name', () => {
  const p = buildPrompt({ leadName: 'Sofia Lindqvist', text: 'Sounds great!' });
  assert.match(p, /Sofia Lindqvist/);
});

test('buildPrompt includes the reply text', () => {
  const p = buildPrompt({ leadName: 'Rachel Osei', text: 'Yes — happy to join. Who else is confirmed?' });
  assert.match(p, /Yes — happy to join\. Who else is confirmed\?/);
});

test('buildPrompt truncates the reply text at 2000 chars', () => {
  const long = 'x'.repeat(5000);
  const p = buildPrompt({ leadName: 'Long Replier', text: long });
  // The interpolated slice is exactly 2000 x's — the 2001st must be absent.
  assert.ok(p.includes('x'.repeat(2000)));
  assert.ok(!p.includes('x'.repeat(2001)));
});

test('buildPrompt includes the campaign when present', () => {
  const p = buildPrompt({ leadName: 'Dan', text: 'Hi', campaign: 'FinTech CTOs' });
  assert.match(p, /FinTech CTOs/);
});

test('buildPrompt includes the sending profile name when present', () => {
  const p = buildPrompt({ leadName: 'Dan', text: 'Hi', profileName: 'Marta Kowalski' });
  assert.match(p, /Marta Kowalski/);
});

test('buildPrompt carries the anti-fabrication instruction', () => {
  const p = buildPrompt({ leadName: 'Dan', text: 'When is it?' });
  // The fixed template must instruct the model not to invent specifics.
  assert.match(p, /never invent dates, links, or names/);
  assert.match(p, /Output ONLY the reply text/);
});

test('buildPrompt is a fixed template — output only the reply text, no markdown', () => {
  const p = buildPrompt({ leadName: 'Dan', text: 'Hi' });
  assert.match(p, /The Ortus Club/);
  assert.match(p, /no subject line, no signature, no markdown/);
});

test('buildPrompt handles a missing lead name gracefully', () => {
  const p = buildPrompt({ text: 'Hello there' });
  assert.match(p, /\(unknown name\)/);
  assert.match(p, /Hello there/);
});

test('buildPrompt handles missing text without throwing', () => {
  const p = buildPrompt({ leadName: 'Nobody' });
  assert.match(p, /Nobody/);
  // Empty quoted block is fine — no crash, still a string.
  assert.equal(typeof p, 'string');
});
