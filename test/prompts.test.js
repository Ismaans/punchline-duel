/**
 * Checks the prompt files in server/. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../server/${name}`, import.meta.url), 'utf8'));
const own = read('prompts.json');
const quiplash = read('prompts-quiplash.json');
const normalize = (text) => text.replaceAll('_____', ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

test('Quiplash prompts file names its source and license', () => {
  assert.match(quiplash.source, /github\.com/);
  assert.ok(quiplash.license);
  assert.ok(quiplash.prompts.length > 0);
});

test('every Quiplash prompt is a single-blank round 1/2 prompt with no markup', () => {
  for (const p of quiplash.prompts) {
    assert.equal(p.text.split('_____').length, 2, p.text);
    assert.doesNotMatch(p.text, /[<>[\]{}]/, p.text);
    assert.ok(p.text.length <= 120, p.text);
    assert.equal(p.final, false, p.text);
  }
});

test('prompt ids are unique and no prompt text appears twice across both files', () => {
  const all = [...own, ...quiplash.prompts];
  assert.equal(new Set(all.map((p) => p.id)).size, all.length);
  assert.equal(new Set(all.map((p) => normalize(p.text))).size, all.length);
});
