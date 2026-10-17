import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EVENTS } from '../public/shared/events.js';

test('every event name is unique', () => {
  const names = Object.values(EVENTS);
  assert.equal(new Set(names).size, names.length);
});

test('event constants cannot be changed at runtime', () => {
  assert.ok(Object.isFrozen(EVENTS));
});
