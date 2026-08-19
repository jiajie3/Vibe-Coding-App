/**
 * Auto-review tests.
 *
 * The model's judgement cannot be asserted without calling it, so what is
 * tested here is everything around it: the rules that must fire without a
 * model at all, and the behaviour when there is no key, no network or a bad
 * response. Those are the paths that decide whether a supervisor sees a wrong
 * answer or an honest blank.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROMPT_VERSION, isConfigured, reviewInspection, ruleConcerns } from './ai.ts';
import type { ReviewInput } from './ai.ts';

const base = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  reference: 'INS-2026-004021',
  asset: { name: 'Sungei Whampoa', type: 'canal' },
  min_coverage_pct: 90,
  coverage: { server_pct: 97.4, client_pct: 98.1, flags: [], uncovered_ranges: [] },
  checklist: [
    { id: 'site_accessible', label: 'Site accessible', type: 'boolean', answer: true },
    { id: 'blockage_present', label: 'Blockage present', type: 'boolean', answer: false },
    { id: 'silt_depth_mm', label: 'Silt depth', type: 'number', answer: 20 },
    { id: 'flow_condition', label: 'Flow', type: 'single_select', answer: 'free' },
    { id: 'defect_severity', label: 'Severity', type: 'severity', answer: 1 },
    { id: 'defect_types', label: 'Defects', type: 'multi_select', answer: [] },
    { id: 'remarks', label: 'Remarks', type: 'text', answer: 'Clear throughout, no silt at the outfall.' },
  ],
  photos: [],
  ...over,
});

const answer = (input: ReviewInput, id: string, value: unknown): ReviewInput => ({
  ...input,
  checklist: input.checklist.map((a) => (a.id === id ? { ...a, answer: value } : a)),
});

const kinds = (input: ReviewInput) => ruleConcerns(input).map((c) => c.kind);

/* ---------------------------------------------------------------- rules */

test('a clean inspection raises nothing', () => {
  assert.deepEqual(ruleConcerns(base()), []);
});

test('coverage under the gate is flagged, with both numbers', () => {
  const c = ruleConcerns(base({ coverage: { server_pct: 71.2, client_pct: 100, flags: [], uncovered_ranges: [] } }));
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'coverage_below_gate');
  assert.match(c[0].detail, /71\.2%/);
  assert.match(c[0].detail, /90%/);
});

test('every coverage flag is turned into a sentence, not a slug', () => {
  const c = ruleConcerns(
    base({
      coverage: {
        server_pct: 95,
        client_pct: 95,
        flags: ['mock_location', 'implausible_speed', 'override_used'],
        uncovered_ranges: [],
      },
    }),
  );
  assert.equal(c.length, 3);
  for (const x of c) {
    assert.equal(x.kind, 'coverage_flag');
    assert.ok(/\s/.test(x.detail), `not a sentence: ${x.detail}`);
    assert.ok(!x.detail.includes('_'), `leaked a slug: ${x.detail}`);
  }
});

test('a blockage with no silt and free flow is contradictory twice over', () => {
  let i = answer(base(), 'blockage_present', true);
  i = answer(i, 'silt_depth_mm', 0);
  const k = kinds(i);
  assert.equal(k.filter((x) => x === 'contradiction').length, 2);
});

test('a severe defect with no type and no photo is caught', () => {
  const i = answer(base(), 'defect_severity', 4);
  const k = kinds(i);
  assert.ok(k.includes('contradiction'), 'no defect type selected');
  assert.ok(k.includes('missing_evidence'), 'no photographs attached');
});

test('a severe defect with a type and a photo is not', () => {
  let i = answer(base(), 'defect_severity', 4);
  i = answer(i, 'defect_types', ['siltation']);
  i = { ...i, photos: [{ id: 'a1', chainage_m: 120, path: 'nowhere.jpg' }] };
  assert.deepEqual(ruleConcerns(i), []);
});

test('claiming no access while walking the drain is caught', () => {
  const i = answer(base(), 'site_accessible', false);
  assert.ok(kinds(i).includes('contradiction'));
});

test('remarks that occupy the field without saying anything are flagged', () => {
  for (const empty of ['nil', 'NA', 'n/a', 'ok', 'None', '-', 'nothing']) {
    const i = answer(base(), 'remarks', empty);
    assert.ok(kinds(i).includes('thin_remarks'), `missed: "${empty}"`);
  }
});

test('real remarks are left alone, however short', () => {
  for (const real of ['Silt at outfall, 40 mm.', 'Grating cracked near ch 80.']) {
    const i = answer(base(), 'remarks', real);
    assert.ok(!kinds(i).includes('thin_remarks'), `false positive: "${real}"`);
  }
});

/* -------------------------------------------------------- degradation */

test('with no API key it returns the rules and says why, rather than failing', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(isConfigured(), false);
    const r = await reviewInspection(
      base({ coverage: { server_pct: 60, client_pct: 100, flags: [], uncovered_ranges: [] } }),
    );
    assert.equal(r.verdict, 'skipped');
    assert.match(r.summary, /OPENAI_API_KEY/);
    // The rules still ran: an unconfigured server is not a silent one.
    assert.equal(r.concerns.length, 1);
    assert.equal(r.concerns[0].source, 'rule');
    assert.equal(r.prompt_version, PROMPT_VERSION);
  } finally {
    if (saved) process.env.OPENAI_API_KEY = saved;
  }
});

test('a failed call degrades to skipped rather than to an opinion', async () => {
  const saved = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'sk-test';
  // Replacing fetch for the duration of the test.
  globalThis.fetch = async () => {
    throw new Error('network unreachable');
  };
  try {
    const r = await reviewInspection(base());
    // The dangerous failure is returning `looks_sound` when nothing was read.
    assert.equal(r.verdict, 'skipped');
    assert.equal(r.error, 'exception');
    assert.match(r.summary, /network unreachable/);
  } finally {
    globalThis.fetch = savedFetch;
    if (saved) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});

test('an HTTP error from OpenAI is reported, not swallowed', async () => {
  const saved = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'sk-test';
  // Replacing fetch for the duration of the test.
  globalThis.fetch = async () =>
    new Response('insufficient_quota', { status: 429 });
  try {
    const r = await reviewInspection(base());
    assert.equal(r.verdict, 'skipped');
    assert.equal(r.error, '429');
    assert.match(r.summary, /insufficient_quota/);
  } finally {
    globalThis.fetch = savedFetch;
    if (saved) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});

test('a well-formed reply is merged with the rules, rules first', async () => {
  const saved = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'sk-test';
  // Replacing fetch for the duration of the test.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'needs_a_look',
                confidence: 'medium',
                summary: 'Photograph does not show the reported defect.',
                concerns: [
                  { kind: 'photo_mismatch', detail: 'The photo shows a grass verge.', field: null },
                ],
                photo_notes: [
                  {
                    attachment_id: 'a1',
                    shows_drain: false,
                    quality: 'usable',
                    matches_description: false,
                    note: 'No drain visible.',
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    const r = await reviewInspection(
      base({ coverage: { server_pct: 60, client_pct: 100, flags: [], uncovered_ranges: [] } }),
    );
    assert.equal(r.verdict, 'needs_a_look');
    assert.equal(r.concerns.length, 2);
    assert.equal(r.concerns[0].source, 'rule', 'certain findings should come first');
    assert.equal(r.concerns[1].source, 'model');
    // A null field must not become the string "null" in the console.
    assert.equal(r.concerns[1].field, undefined);
    assert.equal(r.photo_notes[0].shows_drain, false);
    assert.equal(r.model, 'gpt-4.1-mini');
  } finally {
    globalThis.fetch = savedFetch;
    if (saved) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});
