/**
 * Automated first-pass review of a submitted inspection.
 *
 * It never decides. It reads what the inspector recorded, says what looks off,
 * and a supervisor still clicks approve or reject. That division is not
 * squeamishness: approving a drain inspection is an attestation attributable to
 * a person, and a model's approval is attributable to nobody. It also makes
 * being wrong cheap — an advisory flag that is occasionally silly costs a few
 * seconds, where an automatic approval that is occasionally wrong is a drain
 * nobody inspected.
 *
 * Two things it is deliberately not allowed near:
 *
 *   Coverage arithmetic. `server_coverage_pct` is recomputed from the raw GPS
 *   track by the same engine the app uses. Passing that through a language
 *   model would replace a number we can defend with one we would have to
 *   explain. The figures go in as facts it is told not to dispute.
 *
 *   Anything already decidable by a rule. Contradictions we can enumerate are
 *   checked in code below and handed over as already-known, so the model spends
 *   its effort on what rules cannot reach: whether the prose says anything,
 *   and whether the photographs show what was claimed.
 *
 * Unconfigured, it returns a `skipped` review rather than throwing. Review must
 * work with no API key, no network, and no budget.
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.openai.com/v1/chat/completions';

/**
 * Bumped whenever the prompt or the schema changes.
 *
 * Stored with every verdict. Without it, a prompt edit silently changes what
 * past reviews meant and there is no way to tell which ones were produced by
 * which instructions.
 */
export const PROMPT_VERSION = 1;

export const apiKey = () => process.env.OPENAI_API_KEY ?? '';
export const isConfigured = () => apiKey().length > 0;

/**
 * `gpt-4.1-mini` rather than `gpt-4o-mini`.
 *
 * 4o-mini is cheaper per text token and considerably *more* expensive per
 * image, which is the opposite of what its name suggests and the wrong choice
 * for a reviewer whose main job is looking at photographs.
 */
const model = () => process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';

/** `low` is ~85 tokens an image, `high` ~765. High, because reading a defect out of a photo is the point. */
const imageDetail = () => (process.env.OPENAI_IMAGE_DETAIL?.trim() === 'low' ? 'low' : 'high');

/** Bounds the cost and the prompt. Four is plenty to judge an inspection by. */
const MAX_PHOTOS = 4;

/* --------------------------------------------------------------- types */

export type Verdict = 'looks_sound' | 'needs_a_look' | 'likely_reject' | 'skipped';

export interface Concern {
  /** Where it came from, so the console can show rules and judgement differently. */
  source: 'rule' | 'model';
  /** Short slug: `contradiction`, `thin_remarks`, `photo_mismatch`, … */
  kind: string;
  detail: string;
  /** Checklist field id, when the concern is about one. */
  field?: string;
}

export interface PhotoNote {
  attachment_id: string;
  /** False is a strong signal — a photograph of a car park evidences nothing. */
  shows_drain: boolean;
  quality: 'usable' | 'poor';
  /** Null when the inspection claimed no defect to match against. */
  matches_description: boolean | null;
  note: string;
}

export interface AiReview {
  verdict: Verdict;
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  concerns: Concern[];
  photo_notes: PhotoNote[];
  model: string;
  prompt_version: number;
  generated_at: string;
  /** Set when the review could not run. The console shows it plainly. */
  error?: string;
}

export interface ChecklistAnswer {
  id: string;
  label: string;
  type: string;
  answer: unknown;
}

export interface ReviewInput {
  reference: string;
  asset: { name: string; type: string };
  min_coverage_pct: number;
  coverage: {
    server_pct: number;
    client_pct: number | null;
    flags: string[];
    uncovered_ranges: [number, number][];
  };
  checklist: ChecklistAnswer[];
  photos: { id: string; caption?: string; chainage_m: number | null; path: string }[];
  override_reason?: string | null;
}

/* ------------------------------------------------------- rule concerns */

const answerOf = (c: ChecklistAnswer[], id: string) => c.find((a) => a.id === id)?.answer;
const isBlank = (v: unknown) =>
  v == null ||
  (typeof v === 'string' && v.trim().length === 0) ||
  (Array.isArray(v) && v.length === 0);

/** Prose that occupies a field without saying anything. */
const EMPTY_PROSE = /^(nil|na|n\/a|none|ok|okay|fine|good|no issue[s]?|nothing|-|\.)$/i;

/**
 * What a rule can decide, decided by a rule.
 *
 * These are cheaper, instant, and cannot hallucinate. They are also handed to
 * the model as already-found, so it does not spend its attention re-deriving
 * them and does not pad its answer by repeating them back.
 */
export function ruleConcerns(input: ReviewInput): Concern[] {
  const out: Concern[] = [];
  const c = input.checklist;

  if (input.coverage.server_pct < input.min_coverage_pct) {
    out.push({
      source: 'rule',
      kind: 'coverage_below_gate',
      detail: `Coverage ${input.coverage.server_pct.toFixed(1)}% is under the ${input.min_coverage_pct}% required.`,
    });
  }

  for (const flag of input.coverage.flags) {
    out.push({
      source: 'rule',
      kind: 'coverage_flag',
      detail:
        flag === 'mock_location'
          ? 'The handset reported a mock location provider.'
          : flag === 'implausible_speed'
            ? 'Movement between fixes was faster than walking.'
            : flag === 'large_gap_bridged'
              ? 'A gap too large to credit was left in the track.'
              : flag === 'override_used'
                ? 'The coverage gate was overridden.'
                : flag,
    });
  }

  const blockage = answerOf(c, 'blockage_present');
  const silt = answerOf(c, 'silt_depth_mm');
  if (blockage === true && typeof silt === 'number' && silt === 0) {
    out.push({
      source: 'rule',
      kind: 'contradiction',
      field: 'silt_depth_mm',
      detail: 'A blockage was reported with a silt depth of zero.',
    });
  }
  if (blockage === true && answerOf(c, 'flow_condition') === 'free') {
    out.push({
      source: 'rule',
      kind: 'contradiction',
      field: 'flow_condition',
      detail: 'A blockage was reported alongside free flow.',
    });
  }

  const severity = answerOf(c, 'defect_severity');
  if (typeof severity === 'number' && severity >= 3 && isBlank(answerOf(c, 'defect_types'))) {
    out.push({
      source: 'rule',
      kind: 'contradiction',
      field: 'defect_types',
      detail: `Severity ${severity} recorded with no defect type selected.`,
    });
  }
  if (typeof severity === 'number' && severity >= 3 && input.photos.length === 0) {
    out.push({
      source: 'rule',
      kind: 'missing_evidence',
      detail: `Severity ${severity} recorded with no photographs attached.`,
    });
  }

  if (answerOf(c, 'site_accessible') === false && input.coverage.server_pct > 50) {
    out.push({
      source: 'rule',
      kind: 'contradiction',
      field: 'site_accessible',
      detail: `Site recorded as inaccessible, yet ${input.coverage.server_pct.toFixed(0)}% of the drain was walked.`,
    });
  }

  const remarks = answerOf(c, 'remarks');
  if (typeof remarks === 'string' && EMPTY_PROSE.test(remarks.trim())) {
    out.push({
      source: 'rule',
      kind: 'thin_remarks',
      field: 'remarks',
      detail: `Remarks say only "${remarks.trim()}".`,
    });
  }

  return out;
}

/* ------------------------------------------------------------- prompt */

const SYSTEM = `You review drain inspection reports for a Singapore flood-protection agency.

You do NOT approve or reject anything. A supervisor decides. Your job is to read
what the inspector recorded and say what a careful reviewer should look at.

Rules you must follow:

1. The coverage percentage, the coverage flags and the uncovered ranges are
   supplied as facts. They were computed from the raw GPS track by the system
   itself. Never dispute, recompute or estimate them.
2. Concerns already found by rules are listed for you. Do not repeat them. Say
   something new or say nothing.
3. Judge the writing and the photographs. Does the prose actually describe
   something? Do the photographs show a drain, and do they show the defect that
   was claimed?
4. Be specific. "Remarks are vague" is useless; "remarks say 'ok' for a severity
   4 structural defect" is actionable.
5. If nothing is wrong, say so plainly and return no concerns. A reviewer who
   finds a problem every time gets ignored.

Verdicts:
  looks_sound   nothing needs a human's attention beyond a glance
  needs_a_look  something specific is worth checking before approving
  likely_reject the record does not support approval as it stands`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'summary', 'concerns', 'photo_notes'],
  properties: {
    verdict: { type: 'string', enum: ['looks_sound', 'needs_a_look', 'likely_reject'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string', description: 'One sentence a supervisor can read at a glance.' },
    concerns: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'detail', 'field'],
        properties: {
          kind: { type: 'string' },
          detail: { type: 'string' },
          field: { type: ['string', 'null'], description: 'Checklist field id, or null.' },
        },
      },
    },
    photo_notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'attachment_id',
          'shows_drain',
          'quality',
          'matches_description',
          'note',
        ],
        properties: {
          attachment_id: { type: 'string' },
          shows_drain: { type: 'boolean' },
          quality: { type: 'string', enum: ['usable', 'poor'] },
          matches_description: { type: ['boolean', 'null'] },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;

function describe(input: ReviewInput, rules: Concern[]): string {
  const answers = input.checklist
    .map((a) => `  - ${a.label} (${a.id}): ${JSON.stringify(a.answer)}`)
    .join('\n');
  const gaps =
    input.coverage.uncovered_ranges.length === 0
      ? 'none'
      : input.coverage.uncovered_ranges.map(([a, b]) => `${a}–${b} m`).join(', ');

  return [
    `Inspection ${input.reference} — ${input.asset.name} (${input.asset.type}).`,
    '',
    'FACTS (computed by the system; do not dispute):',
    `  Coverage: ${input.coverage.server_pct.toFixed(1)}% (gate is ${input.min_coverage_pct}%)`,
    input.coverage.client_pct == null
      ? ''
      : `  Handset claimed: ${input.coverage.client_pct.toFixed(1)}%`,
    `  Flags: ${input.coverage.flags.length ? input.coverage.flags.join(', ') : 'none'}`,
    `  Unwalked stretches: ${gaps}`,
    input.override_reason ? `  Override reason given: "${input.override_reason}"` : '',
    '',
    'CHECKLIST:',
    answers || '  (none submitted)',
    '',
    'ALREADY FOUND BY RULES (do not repeat):',
    rules.length ? rules.map((r) => `  - ${r.detail}`).join('\n') : '  (nothing)',
    '',
    input.photos.length
      ? `PHOTOGRAPHS: ${input.photos.length} attached, below. Their ids are: ${input.photos
          .map((p) => p.id)
          .join(', ')}. Return one photo_note per photograph, using these ids.`
      : 'PHOTOGRAPHS: none attached.',
  ]
    .filter(Boolean)
    .join('\n');
}

/* --------------------------------------------------------------- call */

const skipped = (reason: string): AiReview => ({
  verdict: 'skipped',
  confidence: 'low',
  summary: reason,
  concerns: [],
  photo_notes: [],
  model: 'none',
  prompt_version: PROMPT_VERSION,
  generated_at: new Date().toISOString(),
});

/**
 * Review one inspection.
 *
 * Never throws. A failed review is a review that says it failed — an outage at
 * OpenAI must not stop a supervisor working, and must not look like an opinion
 * that everything is fine.
 */
export async function reviewInspection(input: ReviewInput): Promise<AiReview> {
  const rules = ruleConcerns(input);

  if (!isConfigured()) {
    return {
      ...skipped('No OPENAI_API_KEY is set, so only the rule checks ran.'),
      concerns: rules,
    };
  }

  const content: unknown[] = [{ type: 'text', text: describe(input, rules) }];
  for (const p of input.photos.slice(0, MAX_PHOTOS)) {
    try {
      const b64 = readFileSync(p.path).toString('base64');
      content.push({
        type: 'text',
        text: `Photograph ${p.id}${p.caption ? ` — "${p.caption}"` : ''}${
          p.chainage_m != null ? ` (chainage ${Math.round(p.chainage_m)} m)` : ''
        }`,
      });
      content.push({
        type: 'image_url',
        // Sent as data, not as a URL. OpenAI would have to fetch a URL itself,
        // which fails on a laptop and would mean exposing the photographs
        // publicly on any deployment that worked.
        image_url: { url: `data:image/jpeg;base64,${b64}`, detail: imageDetail() },
      });
    } catch {
      // A missing file is not a reason to abandon the review.
    }
  }

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'inspection_review', strict: true, schema: SCHEMA },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        ...skipped(`Review failed: ${res.status} ${body.slice(0, 200)}`),
        concerns: rules,
        error: `${res.status}`,
      };
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = body.choices?.[0]?.message?.content;
    if (!raw) return { ...skipped('The model returned nothing.'), concerns: rules, error: 'empty' };

    const parsed = JSON.parse(raw) as {
      verdict: Exclude<Verdict, 'skipped'>;
      confidence: AiReview['confidence'];
      summary: string;
      concerns: { kind: string; detail: string; field: string | null }[];
      photo_notes: PhotoNote[];
    };

    return {
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      summary: parsed.summary,
      // Rules first: they are certain, and the model's are judgement.
      concerns: [
        ...rules,
        ...parsed.concerns.map((c) => ({
          source: 'model' as const,
          kind: c.kind,
          detail: c.detail,
          ...(c.field ? { field: c.field } : {}),
        })),
      ],
      photo_notes: parsed.photo_notes ?? [],
      model: model(),
      prompt_version: PROMPT_VERSION,
      generated_at: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ...skipped(`Review could not run: ${(e as Error).message}`),
      concerns: rules,
      error: 'exception',
    };
  }
}
