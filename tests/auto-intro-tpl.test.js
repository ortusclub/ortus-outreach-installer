import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoIntroTpl } from '../src/linkedin/auto-intro.js';

test('buildAutoIntroTpl stores body under followUpMessage (the key outreach.js reads)', () => {
  const tpl = buildAutoIntroTpl({
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'Hey {first name}, let me introduce you {primary name}. Thanks!',
  });
  assert.equal(tpl.followUpMessage, 'Hey {first name}, let me introduce you {primary name}. Thanks!');
});

test('buildAutoIntroTpl sets introMode=true and introName=primaryName', () => {
  const tpl = buildAutoIntroTpl({
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'body',
  });
  assert.equal(tpl.introMode, true);
  assert.equal(tpl.introName, 'Sam Adcock');
});

test('buildAutoIntroTpl defaults introTitle when not provided', () => {
  const tpl = buildAutoIntroTpl({
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'body',
  });
  assert.equal(tpl.introTitle, 'Introduction: {first name} <> {intro name}');
});

test('buildAutoIntroTpl preserves caller-supplied introTitle', () => {
  const tpl = buildAutoIntroTpl({
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'body',
    introTitle: 'Custom {first name} title',
  });
  assert.equal(tpl.introTitle, 'Custom {first name} title');
});

test('buildAutoIntroTpl exposes primaryName / primaryIntroBody / primaryUrl for placeholder substitution', () => {
  const tpl = buildAutoIntroTpl({
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'body',
    primaryUrl: 'https://linkedin.com/in/sam-adcock',
  });
  assert.equal(tpl.primaryName, 'Sam Adcock');
  assert.equal(tpl.primaryIntroBody, 'body');
  assert.equal(tpl.primaryUrl, 'https://linkedin.com/in/sam-adcock');
});

test('buildAutoIntroTpl does NOT set followUp1 (legacy field that outreach.js does not read)', () => {
  const tpl = buildAutoIntroTpl({
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'body',
  });
  assert.equal(tpl.followUp1, undefined);
});
