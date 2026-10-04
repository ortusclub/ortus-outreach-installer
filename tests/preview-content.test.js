import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPreviewMessage } from '../public/js/preview-content.mjs';
test('connection without a note does not preview metadata as a message', () => {
  assert.equal(hasPreviewMessage({connectionNote:'',introName:'Sam',primaryName:'Sam',primaryUrl:'https://linkedin.com/in/sam',opChannel:'sn_first'}), false);
});
test('message bodies, legacy notes and nested InMail still require preview', () => {
  for (const templates of [{note:'Hi {firstName}'},{ccDmBody:'Welcome'},{inmail:{message:'Hello'}},{inmail:{subject:'Hello'}},{primaryIntroBody:'Meet Sam'}]) assert.equal(hasPreviewMessage(templates), true);
  assert.equal(hasPreviewMessage({connectionNote:'  '}), false);
});
