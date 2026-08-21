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
  photoFieldId,
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
};
/**
 * One photograph, because every inspection needs one.
 *
 * Not conditional on what was found. A drain reported as sound with nothing
 * attached is the one record a reviewer cannot check at all, and "nothing was
 * wrong" is exactly the claim worth being able to see.
 */
const VALID_PHOTOS: Record<string, number> = { general_photos: 1 };

test('template loads with the expected shape', () => {
  assert.equal(tpl.id, 'tpl_open_drain');
  assert.ok(tpl.version >= 1);
  assert.ok(tpl.fields.length > 5);
});

// ------------------------------------------------------------ visibility

test('conditional fields are hidden until their trigger is answered', () => {
  assert.equal(isVisible(field('access_reason'), {}), false);
  assert.equal(isVisible(field('access_reason'), { site_accessible: true }), false);
  assert.equal(isVisible(field('access_reason'), { site_accessible: false }), true);
});

test('"other" opens a box to describe it, and only "other"', () => {
  // Every category list ends in Other, and picking it has to lead somewhere.
  // A category nobody can describe collects the answers that matter least.
  assert.equal(isVisible(field('access_other'), { access_reason: 'locked' }), false);
  assert.equal(isVisible(field('access_other'), { access_reason: 'other' }), true);

  // Multi-selects too: the box opens when Other is among the choices, not only
  // when it is the sole one.
  assert.equal(isVisible(field('defect_other'), { defect_types: ['cracking'] }), false);
  assert.equal(isVisible(field('defect_other'), { defect_types: ['cracking', 'other'] }), true);
  assert.equal(isVisible(field('blockage_other'), { blockage_type: ['silt'] }), false);
  assert.equal(isVisible(field('blockage_other'), { blockage_type: ['other'] }), true);
});

test('defects are asked for at fair, poor and critical', () => {
  // Critical used to skip the question that poor asked: the worse answer
  // collected less detail than the one below it.
  const f = field('defect_types');
  assert.equal(isVisible(f, { structural_condition: 'good' }), false);
  assert.equal(isVisible(f, { structural_condition: 'fair' }), true);
  assert.equal(isVisible(f, { structural_condition: 'poor' }), true);
  assert.equal(isVisible(f, { structural_condition: 'critical' }), true);
});

test('a follow-up disappears when its own trigger disappears', () => {
  // The bug this guards: say the site was not accessible, choose Other, type
  // the reason — then change your mind and say it *was* accessible. "What
  // stopped you?" goes, but the box it opened stayed on the form, still holding
  // the reason for a walk that was no longer blocked.
  //
  // Answers are not cleared when a field hides; they are pruned at submission.
  // So `access_other`'s own condition still held — its trigger was simply no
  // longer on screen to be seen.
  const stuck = { site_accessible: false, access_reason: 'other', access_other: 'Padlocked' };
  assert.equal(isVisible(field('access_other'), stuck, tpl), true);

  const changed = { ...stuck, site_accessible: true };
  assert.equal(isVisible(field('access_reason'), changed, tpl), false);
  assert.equal(
    isVisible(field('access_other'), changed, tpl),
    false,
    'the box must go with the question that opened it',
  );
  assert.ok(!visibleFields(tpl, changed).some((f) => f.id === 'access_other'));

  // The other two chains of the same shape.
  const defects = { structural_condition: 'poor', defect_types: ['other'], defect_other: 'Scour' };
  assert.equal(isVisible(field('defect_other'), defects, tpl), true);
  assert.equal(
    isVisible(field('defect_other'), { ...defects, structural_condition: 'good' }, tpl),
    false,
  );

  const blockage = { blockage_present: true, blockage_type: ['other'], blockage_other: 'Trolley' };
  assert.equal(isVisible(field('blockage_other'), blockage, tpl), true);
  assert.equal(
    isVisible(field('blockage_other'), { ...blockage, blockage_present: false }, tpl),
    false,
  );
});

test('an orphaned follow-up is never validated or submitted', () => {
  // Hidden is not enough on its own: a required box that is invisible must also
  // stop demanding an answer, and must not travel to FRCDE describing an
  // obstruction on a walk that finished.
  const changed = {
    ...VALID,
    site_accessible: true,
    access_reason: 'other',
    access_other: 'Padlocked',
  };
  assert.deepEqual(validate(tpl, changed, VALID_PHOTOS), []);
  assert.ok(!('access_other' in prune(tpl, changed)));
  assert.ok(!('access_reason' in prune(tpl, changed)));
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

test('requires_photo_when still works, for a template that uses it', () => {
  // Not the open-drain template any more: a photograph is required of every
  // inspection there, so a conditional demand could only ever fire alongside
  // the unconditional one. The mechanism stays because the checklist is served
  // by FRCDE, which can publish a form that needs it tomorrow.
  const conditional: ChecklistTemplate = {
    id: 'tpl_conditional',
    version: 1,
    title: 'Conditional',
    fields: [
      {
        id: 'condition',
        type: 'single_select',
        label: 'Condition',
        requires_photo_when: { in: ['poor', 'critical'] },
      },
      { id: 'shots', type: 'photo', label: 'Photographs' },
    ],
  };
  const f = conditional.fields[0];
  assert.equal(requiresPhoto(f, { condition: 'good' }), false);
  assert.equal(requiresPhoto(f, { condition: 'poor' }), true);
  assert.equal(requiresPhoto(f, { condition: 'critical' }), true);

  // And it is satisfied from the photo field, not from the question itself.
  assert.ok(validate(conditional, { condition: 'poor' }, {}).some((e) => e.code === 'photo_required'));
  assert.deepEqual(validate(conditional, { condition: 'poor' }, { shots: 1 }), []);
});

test('a hidden field never demands a photo', () => {
  // blockage_type only shows once a blockage is reported.
  assert.equal(isVisible(field('blockage_type'), { blockage_present: false }), false);
  assert.equal(requiresPhoto(field('blockage_type'), { blockage_present: false }), false);
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
  // access_reason is required, but only when site_accessible is false.
  const errs = validate(tpl, VALID, VALID_PHOTOS);
  assert.ok(!errs.some((e) => e.field_id === 'access_reason'));

  const errs2 = validate(tpl, { ...VALID, site_accessible: false }, VALID_PHOTOS);
  assert.ok(errs2.some((e) => e.field_id === 'access_reason' && e.code === 'required'));
});

test('a photograph filed against a question does not stand in for the section', () => {
  // Photographs used to attach to whichever question demanded one. A count left
  // over on such a field must not clear the requirement, or a record passes
  // with no photograph anybody can find under Photographs.
  const errs = validate(tpl, VALID, { blockage_present: 3 });
  assert.ok(errs.some((e) => e.field_id === 'general_photos' && e.code === 'photo_required'));
});

test('the worst drain on the list needs one photograph, not five', () => {
  // Every answer that used to demand its own picture, at once. Asking for the
  // same photograph of the same drain five times is how an inspector learns to
  // game a form.
  const answers = {
    ...VALID,
    structural_condition: 'critical',
    defect_types: ['wall_collapse'],
    blockage_present: true,
    blockage_type: ['silt'],
    flow_condition: 'surcharged',
  };
  assert.deepEqual(validate(tpl, answers, { general_photos: 1 }), []);
});

test('an inspection with no photograph cannot be submitted', () => {
  // Whatever the drain looked like. Blocked or clear, dry or surcharged, the
  // record has to carry something a reviewer can look at.
  const errs = validate(tpl, VALID, {});
  assert.ok(
    errs.some((e) => e.field_id === 'general_photos' && e.code === 'photo_required'),
    `expected a photograph to be demanded, got ${JSON.stringify(errs)}`,
  );
  assert.deepEqual(validate(tpl, VALID, { general_photos: 1 }), []);
});

test('photographs come first in the form', () => {
  // Where the evidence goes is the first thing an inspector should see, not
  // something they scroll past four sections of questions to reach. The photo
  // field is also what every triggered requirement is satisfied from, so a form
  // that hides it produces errors pointing at a section nobody has found yet.
  assert.equal(tpl.sections?.[0]?.id, photoFieldSection());
  assert.equal(tpl.fields[0].type, 'photo');

  // And remarks stay at the end. Closing comments before any question is asked
  // is the wrong order to think in.
  assert.equal(tpl.fields[tpl.fields.length - 1].id, 'remarks');
});

/** The section holding the template's photo field. */
function photoFieldSection(): string | undefined {
  const id = photoFieldId(tpl);
  return tpl.fields.find((f) => f.id === id)?.section_id;
}

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
  // Against a fixture, not the open-drain template: the severity grade was its
  // last numeric field and has been dropped — it asked an inspector to score
  // 1-5 what they had just named in words. The engine still enforces ranges, so
  // FRCDE can publish a numeric question without an app release.
  const gauged: ChecklistTemplate = {
    id: 'tpl_gauged',
    version: 1,
    title: 'Gauged',
    fields: [{ id: 'depth_mm', type: 'number', label: 'Depth', min: 0, max: 500 }],
  };
  assert.ok(validate(gauged, { depth_mm: 900 }, {}).some((e) => e.code === 'out_of_range'));
  assert.deepEqual(validate(gauged, { depth_mm: 120 }, {}), []);
});

// ----------------------------------------------------- pruning answers

test('answers orphaned by a changed trigger are pruned', () => {
  // Inspector says yes, fills in the detail, then changes their mind.
  const answers: Answers = {
    ...VALID,
    blockage_present: true,
    blockage_type: ['silt'],
  };
  assert.ok('blockage_type' in prune(tpl, answers));

  const reverted = { ...answers, blockage_present: false };
  const pruned = prune(tpl, reverted);
  assert.ok(!('blockage_type' in pruned), 'orphaned answer must not be submitted');
});

test('completeness tracks required visible fields', () => {
  assert.ok(completeness(tpl, {}) < 0.2);
  // Optional fields left blank must not hold the bar below 100% — an inspector
  // who has answered everything mandatory is done.
  assert.equal(completeness(tpl, VALID), 1);
  // Unlocking a *required* follow-up drops it back.
  assert.ok(completeness(tpl, { ...VALID, site_accessible: false }) < 1);
});
