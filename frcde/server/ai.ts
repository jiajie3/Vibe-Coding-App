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
export const PROMPT_VERSION = 5;

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

export interface AiReview {
  verdict: Verdict;
  confidence: 'low' | 'medium' | 'high';
  /**
   * The whole answer, in prose.
   *
   * This used to arrive as a taxonomy — concerns split from photo notes, rule
   * findings tagged separately from the model's — and a reviewer had to
   * assemble the meaning from four lists. What they want is the same thing a
   * colleague would say: here is what I would do, and here is why. Rule
   * findings lead it, because they are certain.
   */
  explanation: string;
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
  /** Option labels, so a select reads as "Surcharged / overtopping", not "surcharged". */
  options?: { value: string; label: string }[];
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
  photos: {
    id: string;
    caption?: string;
    chainage_m: number | null;
    path: string;
    /**
     * How the photograph was taken. Only ever `camera` on anything recent.
     *
     * CFPI no longer offers the phone's album, so there is nothing left to
     * weigh: every photograph was taken on the walk, at a recorded position.
     * The field survives for records made when the album was still an option,
     * and the review no longer reasons about it either way.
     */
    source?: 'camera' | 'library';
    /** The checklist question this was attached to, if any. */
    field_label?: string;
    /** What the inspector answered that question, in words. */
    field_answer?: string;
  }[];
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
  if (blockage === true && answerOf(c, 'flow_condition') === 'free') {
    out.push({
      source: 'rule',
      kind: 'contradiction',
      field: 'flow_condition',
      detail: 'A blockage was reported alongside free flow.',
    });
  }

  /**
   * Serious deterioration, described only by the word for it.
   *
   * Keyed on the condition rather than the severity grade, which CFPI has
   * dropped — it asked an inspector to score 1-5 what they had just named in
   * words, and the two disagreed as often as they agreed. "Poor" and "critical"
   * carry the same meaning without the arithmetic.
   */
  const condition = String(answerOf(c, 'structural_condition') ?? '');
  const serious = condition === 'poor' || condition === 'critical';
  if (serious && isBlank(answerOf(c, 'defect_types'))) {
    out.push({
      source: 'rule',
      kind: 'contradiction',
      field: 'defect_types',
      detail: `Structural condition recorded as ${condition} with no defect type selected.`,
    });
  }
  if (serious && input.photos.length === 0) {
    out.push({
      source: 'rule',
      kind: 'missing_evidence',
      detail: `Structural condition recorded as ${condition} with no photographs attached.`,
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

  /**
   * Flow that is not flowing.
   *
   * A drain recorded as surcharged or overtopping is a flood risk on its own,
   * and it always warrants a look — however tidy the rest of the form is.
   */
  const flow = answerOf(c, 'flow_condition');
  if (flow === 'surcharged' || flow === 'restricted') {
    const word = flow === 'surcharged' ? 'surcharged or overtopping' : 'restricted';
    out.push({
      source: 'rule',
      kind: 'significant_condition',
      field: 'flow_condition',
      detail: `Flow was recorded as ${word}.`,
    });

    /**
     * …and with no cause recorded, the form contradicts itself.
     *
     * Water backs up because something restricts it. A drain that is
     * overtopping while the same form reports no blockage, no defect and sound
     * structure is describing two different drains.
     */
    const noBlockage = answerOf(c, 'blockage_present') === false;
    const noDefects = isBlank(answerOf(c, 'defect_types'));
    // Only real deterioration explains a surcharge. `good`, `fair`, and a field
    // left unanswered all mean the same thing here: nothing on the form
    // accounts for the water. Requiring `good` exactly would let the
    // contradiction slip through whenever the question went unanswered — which
    // is precisely the report that deserves the most attention.
    const structuralCause = ['poor', 'critical'].includes(
      String(answerOf(c, 'structural_condition') ?? ''),
    );
    if (noBlockage && noDefects && !structuralCause) {
      out.push({
        source: 'rule',
        kind: 'contradiction',
        field: 'flow_condition',
        detail:
          `Flow recorded as ${word}, yet no blockage, no defect and sound structure ` +
          'were recorded — nothing on the form explains why the water is backing up.',
      });
    }
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
3. Answer in prose, as a colleague would: what you would do, and why. Do not
   produce lists, headings or categories.
4. Judge the writing. Does the prose actually describe something, or does it
   occupy the field without saying anything?
5. Check every photograph against EVERY recorded condition, not only against a
   claimed defect. In particular:
     - flow condition. A drain recorded as surcharged or overtopping should not
       photograph as dry or empty. A drain recorded as dry should not photograph
       full of water.
     - blockage. "No blockage" should not photograph with silt, refuse or
       vegetation obstructing the channel.
     - structural condition. "Good, no visible defects" should not photograph
       with cracking, spalling or a collapsed wall.
   Say so plainly when a photograph contradicts a recorded condition. That is
   always worth reporting, however tidy the rest of the report looks.
6. Each photograph is labelled with the checklist question it was attached to
   and the answer given. Judge it against that answer first. A photograph
   attached to "was the full stretch accessible? No" should show something
   obstructing access; one attached to "blockage present? Yes" should show the
   blockage. A photograph that does not evidence the answer it is filed under is
   worth reporting even when it is a perfectly good photograph of a drain.
7. Every photograph was taken during the walk, at a recorded position — the
   app has no way to attach one from the phone's album. Do not speculate about
   where a photograph came from.
8. Be specific. "Remarks are vague" is useless; "remarks say 'ok' for a severity
   4 structural defect" is actionable.
9. If genuinely nothing is wrong, say so plainly and return no concerns. Do not
   invent concerns to seem thorough — but do not withhold a real one because the
   report is otherwise neat.

Verdicts:
  looks_sound   nothing needs a human's attention beyond a glance
  needs_a_look  something specific is worth checking before approving
  likely_reject the record does not support approval as it stands`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'explanation'],
  properties: {
    verdict: { type: 'string', enum: ['looks_sound', 'needs_a_look', 'likely_reject'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    explanation: {
      type: 'string',
      description:
        'Two or three sentences of plain prose: what a supervisor should do about '
        + 'this inspection and why. No lists, no headings, no categories.',
    },
  },
} as const;

/** `surcharged` means nothing to a reader; "Surcharged / overtopping" does. */
function readable(a: ChecklistAnswer): string {
  const label = (v: unknown) =>
    a.options?.find((o) => o.value === v)?.label ?? String(v);
  if (Array.isArray(a.answer)) {
    return a.answer.length ? a.answer.map(label).join(', ') : '(none selected)';
  }
  if (a.answer === true) return 'Yes';
  if (a.answer === false) return 'No';
  if (a.answer == null || a.answer === '') return '(blank)';
  return label(a.answer);
}

function describe(input: ReviewInput, rules: Concern[]): string {
  const answers = input.checklist
    .map((a) => `  - ${a.label} (${a.id}): ${readable(a)}`)
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
      ? `PHOTOGRAPHS: ${input.photos.length} attached below, each labelled with ` +
        'the checklist question it was filed under, the answer given, and where ' +
        'along the drain it was taken.'
      : 'PHOTOGRAPHS: none attached.',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ----------------------------------------------------- drafting a rejection */

/**
 * The reason codes the console offers.
 *
 * Duplicated in RejectInspection.tsx, which owns their labels and hints. Kept
 * as bare strings on both sides rather than shared through a module: the console
 * is a separate bundle, and a code that drifts shows up immediately as a reason
 * that will not select.
 */
export const REJECTION_CODES = [
  'coverage_gaps',
  'insufficient_photos',
  'checklist_incomplete',
  'photo_quality',
  'override_not_justified',
  'other',
] as const;

export interface RejectionDraft {
  code: (typeof REJECTION_CODES)[number];
  note: string;
}

/**
 * Write the sentence the inspector will read, not the one the reviewer read.
 *
 * The review explains an inspection to a supervisor: "a supervisor should ask
 * the inspector for clearer photographs". Pasted into a rejection that goes
 * back to the inspector, it addresses them in the third person about
 * themselves. Same facts, wrong reader — so this is its own prompt rather than
 * a reuse of that text.
 *
 * It also picks the reason code, because the reviewer would otherwise read the
 * draft and then hunt for the category it obviously belongs to.
 */
const DRAFT_SYSTEM = `You are drafting a short message to the field inspector who
walked this drain, explaining why their inspection is being sent back.

Write TO the inspector, in the second person. "Please re-walk the last 120 m" —
not "the supervisor should ask the inspector to re-walk". Never refer to them in
the third person, and never refer to the supervisor at all.

One or two sentences. No greeting, no sign-off, no apology. Say what is wrong
and what to do about it, concretely, using the chainages and the field names
from the report where they help.

Rejecting is the supervisor's decision, already taken. You are not being asked
whether it is right, and you must NOT manufacture grounds for it. If the record
genuinely does not support sending this back, say so: choose "other" and write a
note asking the inspector to expect the supervisor's own explanation. A drafted
reason that invents a fault is worse than no draft, because it goes out over the
supervisor's name and the inspector will act on it.

Where a reading of this inspection is supplied below, stay consistent with it.
Two accounts of the same drain that disagree is how a reviewer stops trusting
either.

Also choose the single reason code that best fits:
  coverage_gaps           stretches of the drain were not walked
  insufficient_photos     defects reported without photographs to support them
  checklist_incomplete    answers missing, contradictory or clearly wrong
  photo_quality           photographs blurred, too dark, or not showing the defect
  override_not_justified  submitted short of coverage without an adequate reason
  other                   none of the above fits`;

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'note'],
  properties: {
    code: { type: 'string', enum: [...REJECTION_CODES] },
    note: {
      type: 'string',
      description: 'One or two sentences addressed directly to the inspector.',
    },
  },
} as const;

/** Returns null when it cannot draft — the console then says so rather than guessing. */
export async function draftRejection(
  input: ReviewInput,
  /** What the check on the review page concluded, when it has been run. */
  priorReading?: string,
): Promise<RejectionDraft | null> {
  if (!isConfigured()) return null;

  const rules = ruleConcerns(input);
  const content: unknown[] = [{ type: 'text', text: describe(input, rules) }];
  if (priorReading) {
    content.push({
      type: 'text',
      text: `A READING OF THIS INSPECTION HAS ALREADY BEEN MADE:
${priorReading}`,
    });
  }
  for (const p of input.photos.slice(0, MAX_PHOTOS)) {
    try {
      const b64 = readFileSync(p.path).toString('base64');
      content.push({
        type: 'text',
        text: `Photograph ${p.id}${
          p.field_label ? ` filed under "${p.field_label}" (answered "${p.field_answer ?? '—'}")` : ''
        }.`,
      });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}`, detail: imageDetail() },
      });
    } catch {
      // A photograph that cannot be read is not a reason to abandon the draft.
    }
  }

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        messages: [
          { role: 'system', content: DRAFT_SYSTEM },
          { role: 'user', content },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'rejection_draft', strict: true, schema: DRAFT_SCHEMA },
        },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = body.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RejectionDraft;
    if (!REJECTION_CODES.includes(parsed.code)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* -------------------------------------------------- drafting a follow-up */

export interface FollowUpDraft {
  detail: string;
  /** One of the channels offered, or '' for "record it, tell nobody". */
  channel: string;
}

/**
 * Write the case a contractor will act on, and choose where it opens.
 *
 * A third reader again. The review speaks to a supervisor and a rejection to
 * the inspector; this one is read by whoever turns up with a jetting truck, who
 * was not there and cannot see the drain. It needs the chainage and what was
 * found, and nothing about coverage or inspection procedure.
 *
 * Routing is a judgement about *what kind of problem* it is, which is why it is
 * asked of a model at all: the rules in routing.ts can only match words a
 * supervisor typed, and here nobody has typed anything yet.
 */
export async function draftFollowUp(
  input: ReviewInput,
  channels: { channel: string; label: string }[],
): Promise<FollowUpDraft | null> {
  if (!isConfigured() || channels.length === 0) return null;

  const system = `You are writing a maintenance follow-up for a Singapore drain,
from an inspection report, and choosing who it goes to.

The reader is the crew who will do the work. They were not at the inspection and
cannot see the drain. Tell them what was found and where — use the chainage and
the drain's name. One or two sentences, plain and specific. No greeting, no
sign-off. Say nothing about coverage, GPS or inspection procedure: none of it is
their business and none of it helps them.

Choose exactly one channel from this list:
${channels.map((c) => `  ${c.channel}  — ${c.label}`).join('\n')}

Route by the kind of problem, not by who reported it:
  - anything inside the drain: silt, litter, refuse, vegetation, blockage,
    obstruction, cleanliness, standing water, mosquito breeding — these go to
    the environment agency channel (NEA)
  - anything on or about the road: the carriageway, kerbs, gratings in the road,
    a collapsed edge under a road, vehicular access — these go to the transport
    authority channel (LTA)
  - if neither fits, choose the channel whose label best matches, or return ""
    to record the follow-up without opening a case anywhere.

Do not invent work. If the inspection found nothing needing a follow-up, return
"" as the channel and say plainly in the detail that no remedial work was
identified.`;

  const rules = ruleConcerns(input);
  const content: unknown[] = [{ type: 'text', text: describe(input, rules) }];
  for (const p of input.photos.slice(0, MAX_PHOTOS)) {
    try {
      const b64 = readFileSync(p.path).toString('base64');
      content.push({
        type: 'text',
        text: `Photograph ${p.id}${
          p.field_label ? ` filed under "${p.field_label}" (answered "${p.field_answer ?? '—'}")` : ''
        }${p.chainage_m != null ? `, ${Math.round(p.chainage_m)} m along the drain` : ''}.`,
      });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}`, detail: imageDetail() },
      });
    } catch {
      // Unreadable photograph, skipped — not a reason to abandon the draft.
    }
  }

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'follow_up_draft',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['detail', 'channel'],
              properties: {
                detail: {
                  type: 'string',
                  description: 'One or two sentences for the crew doing the work.',
                },
                channel: {
                  type: 'string',
                  enum: ['', ...channels.map((c) => c.channel)],
                },
              },
            },
          },
        },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = body.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FollowUpDraft;
    // A channel nobody offered would post nowhere and look broken.
    if (parsed.channel && !channels.some((c) => c.channel === parsed.channel)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- call */

/** Rule findings as prose, so they can lead an explanation rather than sit in a list. */
const sentences = (rules: Concern[]) =>
  rules.length === 0 ? 'The checks found nothing.' : rules.map((r) => r.detail).join(' ');

const skipped = (reason: string): AiReview => ({
  verdict: 'skipped',
  confidence: 'low',
  explanation: reason,
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
    return skipped(
      'No OPENAI_API_KEY is set, so nothing was read. ' + sentences(rules),
    );
  }

  const content: unknown[] = [{ type: 'text', text: describe(input, rules) }];
  for (const p of input.photos.slice(0, MAX_PHOTOS)) {
    try {
      const b64 = readFileSync(p.path).toString('base64');
      const filed = p.field_label
        ? `Filed under "${p.field_label}", answered "${p.field_answer ?? 'not answered'}".`
        : 'Not filed under any checklist question.';
      content.push({
        type: 'text',
        text: [
          `Photograph ${p.id}.`,
          filed,
          p.caption ? `Caption: "${p.caption}".` : '',
          p.chainage_m != null ? `${Math.round(p.chainage_m)} m along the drain.` : '',
        ]
          .filter(Boolean)
          .join(' '),
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
        ...skipped(`Could not reach the model (${res.status}). ${sentences(rules)}`),
        error: `${res.status}`,
      };
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = body.choices?.[0]?.message?.content;
    if (!raw) {
      return { ...skipped(`The model returned nothing. ${sentences(rules)}`), error: 'empty' };
    }

    const parsed = JSON.parse(raw) as {
      verdict: Exclude<Verdict, 'skipped'>;
      confidence: AiReview['confidence'];
      explanation: string;
    };

    return {
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      // Rules lead: they are arithmetic and cannot be wrong, where what follows
      // is judgement and occasionally is.
      explanation:
        rules.length > 0
          ? `${sentences(rules)} ${parsed.explanation}`
          : parsed.explanation,
      model: model(),
      prompt_version: PROMPT_VERSION,
      generated_at: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ...skipped(`Could not run the check: ${(e as Error).message}. ${sentences(rules)}`),
      error: 'exception',
    };
  }
}
