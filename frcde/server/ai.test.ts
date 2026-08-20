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
    {
      id: 'structural_condition',
      label: 'Overall structural condition',
      type: 'single_select',
      answer: 'good',
    },
    { id: 'blockage_present', label: 'Blockage present', type: 'boolean', answer: false },
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

test('a blockage alongside free flow is a contradiction', () => {
  const i = answer(base(), 'blockage_present', true);
  assert.ok(kinds(i).includes('contradiction'));
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

test('with no API key it says so, and still reports what the rules found', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(isConfigured(), false);
    const r = await reviewInspection(
      base({ coverage: { server_pct: 60, client_pct: 100, flags: [], uncovered_ranges: [] } }),
    );
    assert.equal(r.verdict, 'skipped');
    assert.match(r.explanation, /OPENAI_API_KEY/);
    // An unconfigured server is not a silent one: the rule finding still shows.
    assert.match(r.explanation, /60\.0% is under the 90%/);
    assert.equal(r.prompt_version, PROMPT_VERSION);
  } finally {
    if (saved) process.env.OPENAI_API_KEY = saved;
  }
});

test('a failed call degrades to skipped rather than to an opinion', async () => {
  const saved = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'sk-test';
  globalThis.fetch = async () => {
    throw new Error('network unreachable');
  };
  try {
    const r = await reviewInspection(base());
    // The dangerous failure is returning `looks_sound` when nothing was read.
    assert.equal(r.verdict, 'skipped');
    assert.equal(r.error, 'exception');
    assert.match(r.explanation, /network unreachable/);
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
  globalThis.fetch = async () => new Response('insufficient_quota', { status: 429 });
  try {
    const r = await reviewInspection(base());
    assert.equal(r.verdict, 'skipped');
    assert.equal(r.error, '429');
    assert.match(r.explanation, /429/);
  } finally {
    globalThis.fetch = savedFetch;
    if (saved) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});

test('rule findings lead the explanation, and the model follows', async () => {
  const saved = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'sk-test';
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'needs_a_look',
                confidence: 'medium',
                explanation: 'The photograph shows a grass verge, not the drain.',
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
    // Certain first, judgement second.
    assert.ok(
      r.explanation.indexOf('under the 90%') < r.explanation.indexOf('grass verge'),
      `rules should lead: ${r.explanation}`,
    );
    assert.equal(r.model, 'gpt-4.1-mini');
  } finally {
    globalThis.fetch = savedFetch;
    if (saved) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});

test('with nothing wrong, the explanation is the model alone', async () => {
  const saved = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'sk-test';
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'looks_sound',
                confidence: 'high',
                explanation: 'Full coverage and the photographs match the record.',
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    const r = await reviewInspection(base());
    assert.equal(r.explanation, 'Full coverage and the photographs match the record.');
  } finally {
    globalThis.fetch = savedFetch;
    if (saved) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});

/* ------------------------------------- the surcharged-drain false negative */

test('surcharged flow is always surfaced, however tidy the rest of the form', () => {
  // A drain recorded as overtopping is a flood risk on its own. This one got
  // through as "looks sound": the model was shown the raw value `surcharged`
  // and had no claimed defect to check the photograph against.
  const i = answer(base(), 'flow_condition', 'surcharged');
  const k = kinds(i);
  assert.ok(k.includes('significant_condition'), 'surcharging was not surfaced');
});

test('surcharged with no cause recorded is a contradiction', () => {
  // Water backs up because something restricts it. Overtopping alongside no
  // blockage, no defect and sound structure describes two different drains.
  let i = answer(base(), 'flow_condition', 'surcharged');
  i = answer(i, 'structural_condition', 'good');
  const c = ruleConcerns(i);
  assert.ok(c.some((x) => x.kind === 'contradiction'), 'no contradiction raised');
  assert.ok(
    c.some((x) => /nothing on the form explains/.test(x.detail)),
    'the contradiction should say why it is one',
  );
});

test('restricted flow is surfaced too', () => {
  const i = answer(base(), 'flow_condition', 'restricted');
  assert.ok(kinds(i).includes('significant_condition'));
});

test('surcharging with a cause recorded is noted but not contradictory', () => {
  let i = answer(base(), 'flow_condition', 'surcharged');
  i = answer(i, 'blockage_present', true);
  const c = ruleConcerns(i);
  assert.ok(c.some((x) => x.kind === 'significant_condition'), 'still worth surfacing');
  assert.ok(
    !c.some((x) => x.field === 'flow_condition' && x.kind === 'contradiction'),
    'a blockage explains the surcharge — not a contradiction',
  );
});

test('ordinary flow conditions raise nothing', () => {
  for (const flow of ['dry', 'free', 'standing']) {
    const i = answer(base(), 'flow_condition', flow);
    assert.ok(
      !kinds(i).includes('significant_condition'),
      `false positive on "${flow}"`,
    );
  }
});

test('select answers reach the model as labels, not as codes', async () => {
  // `surcharged` tells a reader nothing; "Surcharged / overtopping" does. The
  // raw code is what the model was given when it missed this.
  const saved = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'sk-test';
  let sent = '';
  globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent = String(init?.body ?? '');
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'needs_a_look',
                confidence: 'high',
                summary: 'x',
                concerns: [],
                photo_notes: [],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    let i = answer(base(), 'flow_condition', 'surcharged');
    i = {
      ...i,
      checklist: i.checklist.map((a) =>
        a.id === 'flow_condition'
          ? {
              ...a,
              options: [
                { value: 'dry', label: 'Dry' },
                { value: 'surcharged', label: 'Surcharged / overtopping' },
              ],
            }
          : a,
      ),
    };
    await reviewInspection(i);
    assert.match(sent, /Surcharged \/ overtopping/, 'the label was not sent');
    // And the instruction that would have caught the dry photograph. Matched on
    // a phrase the prompt does not wrap across a line.
    assert.match(sent, /Check every photograph against EVERY recorded condition/);
    assert.match(sent, /surcharged or overtopping should not/);
  } finally {
    globalThis.fetch = savedFetch;
    if (saved) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});
