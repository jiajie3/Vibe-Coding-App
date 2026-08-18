/**
 * The deadline rule is shared by the app and the console, so a change here
 * changes what "overdue" means in both. Worth pinning down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dueLabel, FLAG_WITHIN_DAYS } from './due.ts';

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

test('red is reserved for genuinely late', () => {
  assert.equal(dueLabel(inDays(-3)).severity, 'overdue');
  assert.equal(dueLabel(inDays(-1)).severity, 'overdue');
  assert.equal(dueLabel(inDays(0)).severity, 'soon');
});

test('amber covers the flag window, grey everything beyond', () => {
  assert.equal(dueLabel(inDays(1)).severity, 'soon');
  assert.equal(dueLabel(inDays(FLAG_WITHIN_DAYS)).severity, 'soon');
  assert.equal(dueLabel(inDays(FLAG_WITHIN_DAYS + 1)).severity, 'later');
  assert.equal(dueLabel(inDays(90)).severity, 'later');
});

test('reads the way an inspector would say it', () => {
  assert.equal(dueLabel(inDays(0)).text, 'Due today');
  assert.equal(dueLabel(inDays(5)).text, 'Due in 5d');
  assert.equal(dueLabel(inDays(-2)).text, 'Overdue by 2d');
});

test('overdue implies soon, so anything flagged is caught by one check', () => {
  const late = dueLabel(inDays(-4));
  assert.equal(late.overdue, true);
  assert.equal(late.soon, true);
});

test('a missing or unparseable date degrades quietly', () => {
  const d = dueLabel('not a date');
  assert.equal(d.severity, 'later');
  assert.equal(d.overdue, false);
  assert.match(d.text, /no due date/i);
});
