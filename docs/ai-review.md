# Automatic first pass

A second opinion on a submitted inspection, **when a supervisor asks for one**.
It never decides anything.

It used to run automatically on every submission. That spent money on
inspections nobody had opened, and put a verdict in front of a reviewer before
they had formed their own — the wrong order for something that is only advice.

## Why it does not decide

Approving a drain inspection is an attestation, and an attestation has to be
attributable to a person. A model's approval is attributable to nobody.

Keeping it advisory also makes being wrong cheap. A flag that is occasionally
silly costs a supervisor a few seconds. An automatic approval that is
occasionally wrong is a drain nobody inspected, discovered after a flood.

So the panel has no buttons that approve or reject. The supervisor's own
controls stay exactly where they were.

## What it is not allowed near

**Coverage arithmetic.** `server_coverage_pct` is recomputed from the raw GPS
track by the same engine the app uses. Passing that through a language model
would replace a number we can defend with one we would have to explain. The
figures go into the prompt as facts it is instructed not to dispute.

**Anything a rule can decide.** Contradictions that can be enumerated are checked
in code and handed to the model as *already found*, so it neither wastes
attention re-deriving them nor pads its answer by repeating them back.

The rules, in [`server/ai.ts`](../frcde/server/ai.ts):

| Check | Fires when |
| --- | --- |
| `coverage_below_gate` | Server coverage is under `min_coverage_pct` |
| `coverage_flag` | Any of `mock_location`, `implausible_speed`, `large_gap_bridged`, `override_used` |
| `contradiction` | Blockage with free flow; poor or critical structure with no defect type; site recorded inaccessible yet more than half the drain walked; surcharged or restricted flow with nothing on the form to explain it |
| `significant_condition` | Flow recorded as surcharged/overtopping or restricted |
| `missing_evidence` | Poor or critical structure with no photographs |
| `thin_remarks` | Remarks that are only "nil", "ok", "n/a", "-" and similar |

These are instant, free, and cannot hallucinate. The console labels them
`rule`; the model's findings are labelled `read`. A reviewer who cannot tell
arithmetic from judgement learns to distrust both.

### Why surcharging has its own rule

An inspection came back reading *"looks sound"* with flow recorded as
**Surcharged / overtopping**, no blockage, sound structure, and a photograph of a
dry drain. Nothing caught it. Three things were wrong at once:

- **No rule covered it.** Overtopping is a flood risk on its own, and overtopping
  with no blockage, no defect and no deterioration recorded is a form describing
  two different drains. Both are now rules, so this can never again depend on the
  model noticing.
- **The model saw a code, not a condition.** Select answers were serialised as
  their raw values — `surcharged`, not "Surcharged / overtopping". Labels are now
  sent.
- **It had nothing to compare the photograph against.** The instruction was to
  check photographs against *the defect that was claimed*, and this report
  claimed none. It now checks every photograph against every recorded
  condition — flow, blockage and structure by name — and sets
  `matches_description` false when a photograph contradicts any of them.

The general lesson is worth keeping: a false negative here is invisible. A
supervisor sees "looks sound" and moves on. That is the argument for putting
anything enumerable into a rule, and for treating the model as the second net
rather than the first.

## Three readers, three prompts

The same inspection is written up three times, because three different people
read it and confusing them is how the wrong words reach the wrong person.

| Asked for | Reader | Produces |
| --- | --- | --- |
| The check | The supervisor | A recommendation and why |
| A rejection | The inspector who walked it | What to do differently, second person |
| A follow-up | The crew who will fix it | What was found and where, plus the channel |

The rejection drafter learned this the hard way: it began by pasting the
check's own paragraph, which says things like "a supervisor should ask the
inspector for clearer photographs" — addressing the inspector in the third
person about themselves.

The rejection drafter is also handed the check's conclusion when there is one,
and told the decision is already taken and not to manufacture grounds for it. A
model asked to explain a rejection will always find something, and an invented
fault goes out over the supervisor's name.

It picks **every reason that applies**, not the closest one, because an
inspection with stretches unwalked and photographs too dark to read fails twice
— and filing it under one meant the second survived only if the note happened to
mention it, so the inspector fixed half of it and submitted again. The
supervisor can tick as many as they like too. Codes the console does not offer
are dropped, duplicates collapse, and "Other" beside a reason that does fit is
discarded: it means *none of these*, so alongside one that fits it is noise.

The follow-up drafter picks the Slack channel as well, because routing here is
a judgement about *what kind of problem* it is — something inside the drain, or
something about the road — and `routing.ts` can only match words a supervisor
typed. At that point nobody has typed anything. Channels it was not offered are
refused rather than passed on: posting to one that does not exist fails long
after anyone is looking.

## The four outcomes

| Shown as | Means |
| --- | --- |
| **Looks approvable** | Nothing needs attention beyond a glance |
| **Worth a look** | Something specific to check before approving |
| **Would send back** | The record does not support approval as it stands |
| **Not checked** | It could not run, or has not been asked to yet |

Each comes with a confidence and a paragraph of prose. None of them does
anything: there is no approve or reject control in the section, and the
supervisor's own buttons are untouched.

## What the model is for

Two things rules cannot reach:

- **Prose that says nothing.** `remarks: "cleared"` against a critical
  structural defect. Whether writing is substantive is a language question.
- **Photographs.** Does the image show a drain at all? Is it too dark or too
  close to evidence anything? Does it show what was recorded — a drain reported
  as surcharged should not photograph as dry.
- **Photographs against the question they were filed under.** Each one is sent
  labelled with its checklist question and the answer given, so a shot attached
  to "was the full stretch accessible? No" is judged on whether it shows
  something blocking access. A perfectly good photograph of a drain that does
  not evidence the answer it is filed under is still worth reporting.
The model is **not** asked where a photograph came from. It used to be, back
when CFPI could attach one from the phone's album; the app no longer can, so
every photograph was taken on the walk at a recorded position and there is
nothing left to weigh. The prompt says so explicitly and tells the model not to
speculate — invite a model to assess provenance and it will produce some.

The answer comes back as a recommendation and a paragraph of prose, not a
taxonomy. It used to arrive as concerns split from photograph notes, each tagged
by origin, and a reader had to assemble the meaning out of four lists. Rule
findings lead the paragraph, because they are certain; the model's judgement
follows.

Up to four photographs per inspection, sent as base64 data rather than as URLs —
OpenAI would otherwise have to fetch them itself, which fails on a laptop and
would mean exposing inspection photographs publicly anywhere it worked.

## Configuring it

```
OPENAI_API_KEY        sk-…              required; absent, only rules run
OPENAI_MODEL          gpt-4.1-mini      default
OPENAI_IMAGE_DETAIL   high | low        default high
```

**`gpt-4.1-mini`, not `gpt-4o-mini`.** 4o-mini is cheaper per text token and
considerably *more* expensive per image — the opposite of what the name
suggests, and the wrong trade for a reviewer whose main job is looking at
photographs.

`OPENAI_IMAGE_DETAIL=low` costs roughly 85 tokens an image instead of ~765. Ample
for "is this dark, blurry, or not a drain", marginal for reading a defect out of
one.

Order of magnitude at these settings: a few thousand inspections including
photographs for US$5. Cost is not the constraint at this scale — verify against
current pricing rather than that figure.

## When it cannot run

Unconfigured, on a network failure, or on an error from OpenAI, the verdict is
`skipped` and the rules still run and still show. The failure that matters is
returning "looks sound" when nothing was actually read, so every failure path
returns `skipped` explicitly rather than an opinion.

An inspection submitted before the key was added shows a **Run again** button.

## Provenance

Each stored review carries the model id, the prompt version and a timestamp, and
the panel prints them. Without that, editing the prompt silently changes what
past verdicts meant, and a decision from six months ago cannot be explained or
reproduced. Bump `PROMPT_VERSION` whenever the prompt or schema changes.

The review is stored on the inspection and not recomputed on each page view — it
costs one call, renders instantly, and does not drift under a reviewer as models
are upgraded.

## What is not covered by tests

The rules, the merge order, and every degradation path are tested, including a
stubbed OpenAI returning a well-formed reply, an HTTP error, and a thrown
exception.

**No test calls OpenAI.** Whether the prompt actually produces good judgement on
your inspections is not something a test can answer — run it against real
submissions and read the output before trusting it.

## Before this touches real data

Inspection photographs and the checklist go to a US API. The GPS track does not,
but the coverage figures derived from it do. That is the same PDPA question as
the Slack integration and wants an answer rather than an assumption. OpenAI's API
terms state that API data is not used for training by default, which mitigates
but does not settle it.
