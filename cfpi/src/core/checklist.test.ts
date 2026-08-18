/**
 * Checklist engine tests, run against the real template FRCDE will serve
 * (contracts/examples/checklist-template.json) rather than a fixture — so a
 * change to the template that breaks the app fails here first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  completeness,
  isVisible,
  prune,
  requiresPhoto,
  validate,
  visibleFields,
} from './checklist.ts';
import type { Answers, ChecklistTemplate } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tpl: ChecklistTemplate = JSON.parse(
  readFileSync(resolve(here, '../../../contracts/examples/checklist-template.json'), 'utf8'),
);

const field = (id: string) => tpl.fields.find((f) => f.id === id)!;

/** A minimally valid submission, used as the baseline for negative tests. */
const VALID: Answers = {
  site_accessible: true,
  structural_condition: 'good',
  blockage_present: false,
  flow_condition: 'free',
  inspector_signature: 'sig_018f3b55',
};
/** General photographs are optional, so the baseline attaches none. */
const VALID_PHOTOS: Record<string, number> = {};

test('template loads with the expected shape', () => {
  assert.equal(tpl.id, 'tpl_open_drain');
  assert.ok(tpl.version >= 1);
  assert.ok(tpl.fields.length > 5);
});

// ------------------------------------------------------------ visibility

test('conditional fields are hidden until their trigger is answered', () => {
  assert.equal(isVisible(field('access_obstruction'), {}), false);
  assert.equal(isVisible(field('access_obstruction'), { site_accessible: true }), false);
  assert.equal(isVisible(field('access_obstruction'), { site_accessible: false }), true);
});

test('unconditional fields are always visible', () => {
  assert.equal(isVisible(field('structural_condition'), {}), true);
});

test('visibleFields grows as answers unlock follow-ups', () => {
  const base = visibleFields(tpl, VALID).length;
  const expanded = visibleFields(tpl, {
    ...VALID,
    blockage_present: true,
    structural_condition: 'poor',
  }).length;
  assert.ok(expanded > base, `${expanded} should exceed ${base}`);
});

// -------------------------------------------------------- photo gating

test('answering "blockage present: yes" makes a photo mandatory', () => {
  assert.equal(requiresPhoto(field('blockage_present'), { blockage_present: false }), false);
  assert.equal(requiresPhoto(field('blockage_present'), { blockage_present: true }), true);
});

test('an "in" condition triggers on any listed value', () => {
  const f = field('structural_condition');
  assert.equal(requiresPhoto(f, { structural_condition: 'good' }), false);
  assert.equal(requiresPhoto(f, { structural_condition: 'fair' }), false);
  assert.equal(requiresPhoto(f, { structural_condition: 'poor' }), true);
  assert.equal(requiresPhoto(f, { structural_condition: 'critical' }), true);
});

test('a hidden field never demands a photo', () => {
  // defect_severity only shows when condition is 'poor'.
  assert.equal(isVisible(field('defect_severity'), { structural_condition: 'good' }), false);
  assert.equal(requiresPhoto(field('defect_severity'), { structural_condition: 'good' }), false);
});

// --------------------------------------------------------- validation

test('a complete submission validates', () => {
  assert.deepEqual(validate(tpl, VALID, VALID_PHOTOS), []);
});

test('missing required answers are reported', () => {
  const errs = validate(tpl, {}, VALID_PHOTOS);
  const ids = errs.map((e) => e.field_id);
  assert.ok(ids.includes('site_accessible'));
  assert.ok(ids.includes('structural_condition'));
  assert.ok(ids.includes('flow_condition'));
});

test('hidden required fields are not demanded', () => {
  // access_obstruction is required, but only when site_accessible is false.
  const errs = validate(tpl, VALID, VALID_PHOTOS);
  assert.ok(!errs.some((e) => e.field_id === 'access_obstruction'));

  const errs2 = validate(tpl, { ...VALID, site_accessible: false }, VALID_PHOTOS);
  assert.ok(errs2.some((e) => e.field_id === 'access_obstruction' && e.code === 'required'));
});

test('a triggered photo requirement blocks submission until satisfied', () => {
  const answers = { ...VALID, blockage_present: true, silt_depth_mm: 120 };

  const blocked = validate(tpl, answers, VALID_PHOTOS);
  assert.ok(blocked.some((e) => e.field_id === 'blockage_present' && e.code === 'photo_required'));

  const cleared = validate(tpl, answers, { ...VALID_PHOTOS, blockage_present: 1 });
  assert.ok(!cleared.some((e) => e.field_id === 'blockage_present'));
});

test('general photographs are optional — no photo blocks submission', () => {
  assert.deepEqual(validate(tpl, VALID, {}), []);
  assert.deepEqual(validate(tpl, VALID, { general_photos: 1 }), []);
});

test('a photo minimum is still enforced when a template sets one', () => {
  // The engine keeps supporting `min` even though the open-drain template no
  // longer uses it — FRCDE can reinstate a minimum without an app release.
  const strict: ChecklistTemplate = {
    id: 'tpl_strict',
    version: 1,
    title: 'Strict',
    fields: [
      { id: 'evidence', type: 'photo', label: 'Evidence', required: true, min: 2 },
    ],
  };
  assert.ok(
    validate(strict, {}, { evidence: 1 }).some((e) => e.code === 'too_few_photos'),
  );
  assert.deepEqual(validate(strict, {}, { evidence: 2 }), []);
});

test('out-of-range numbers are rejected', () => {
  const errs = validate(
    tpl,
    { ...VALID, blockage_present: true, silt_depth_mm: 9999 },
    { ...VALID_PHOTOS, blockage_present: 1 },
  );
  assert.ok(errs.some((e) => e.field_id === 'silt_depth_mm' && e.code === 'out_of_range'));
});

// ----------------------------------------------------- pruning answers

test('answers orphaned by a changed trigger are pruned', () => {
  // Inspector says yes, fills in the detail, then changes their mind.
  const answers: Answers = {
    ...VALID,
    blockage_present: true,
    blockage_type: ['silt'],
    silt_depth_mm: 300,
  };
  assert.ok('blockage_type' in prune(tpl, answers));

  const reverted = { ...answers, blockage_present: false };
  const pruned = prune(tpl, reverted);
  assert.ok(!('blockage_type' in pruned), 'orphaned answer must not be submitted');
  assert.ok(!('silt_depth_mm' in pruned));
});

test('completeness tracks required visible fields', () => {
  assert.ok(completeness(tpl, {}) < 0.2);
  // Optional fields left blank must not hold the bar below 100% — an inspector
  // who has answered everything mandatory is done.
  assert.equal(completeness(tpl, VALID), 1);
  // Unlocking a *required* follow-up drops it back.
  assert.ok(completeness(tpl, { ...VALID, site_accessible: false }) < 1);
});
