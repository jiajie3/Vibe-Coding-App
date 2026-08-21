import { useState } from 'react';

import { api } from '../api.ts';
import type { AiReview } from '../api.ts';
import { toast } from '../toast.ts';

/**
 * Reject an inspection, with a reason the inspector will read.
 *
 * This used to be a browser `prompt()`. The text goes straight to the person who
 * walked the drain and tells them what to do differently — it deserves more than
 * a one-line box with no context about what they submitted.
 *
 * The reason codes are the things reviewers actually send work back for, and
 * more than one can be true at once — an inspection with stretches unwalked and
 * photographs too dark to read fails twice. It used to take a single choice,
 * which meant the second fault survived only if the note happened to mention
 * it; the inspector fixed one thing and submitted again.
 *
 * The note is what makes a reason actionable, and is required only when "Other"
 * is among them — the other five say enough on their own, and demanding a
 * sentence for every rejection is how "see above" and "as discussed" get typed.
 */

export interface RejectionDraft {
  reason: string;
}

const REASONS = [
  {
    code: 'coverage_gaps',
    label: 'Stretches not walked',
    hint: 'Parts of the drain were missed and need covering',
  },
  {
    code: 'insufficient_photos',
    label: 'Not enough evidence',
    hint: 'Defects reported without photographs to support them',
  },
  {
    code: 'checklist_incomplete',
    label: 'Checklist incomplete',
    hint: 'Answers missing, contradictory or clearly wrong',
  },
  {
    code: 'photo_quality',
    label: 'Photographs unusable',
    hint: 'Blurred, too dark, or not showing the defect',
  },
  {
    code: 'override_not_justified',
    label: 'Override not justified',
    hint: 'Submitted short of coverage without an adequate reason',
  },
  { code: 'other', label: 'Other', hint: 'Explain below' },
];

export default function RejectInspection({
  coveragePct,
  gapCount,
  inspectionId,
  review,
  busy,
  onCancel,
  onSubmit,
}: {
  coveragePct: number;
  gapCount: number;
  inspectionId: string;
  review: AiReview | null | undefined;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: RejectionDraft) => void;
}) {
  const [codes, setCodes] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsNote = codes.includes('other');

  /** Toggle, keeping the list in the order the reasons are shown. */
  const toggle = (code: string) => {
    setCodes((prev) =>
      prev.includes(code)
        ? prev.filter((c) => c !== code)
        : REASONS.filter((r) => r.code === code || prev.includes(r.code)).map((r) => r.code),
    );
    setError(null);
  };

  /**
   * Ask for a draft written to the inspector, and the reason it fits.
   *
   * Not the AI check's own words. That paragraph explains an inspection to a
   * supervisor — "a supervisor should ask the inspector for clearer
   * photographs" — and pasted here it addresses the inspector in the third
   * person about themselves. Same facts, wrong reader, so the server asks for
   * this separately.
   *
   * It picks the reason too, since a reviewer handed a draft would otherwise
   * read it and then go hunting for the category it obviously belongs to.
   *
   * A draft, never a send: it lands in the box to be edited, and the rejection
   * still goes out under the supervisor's name.
   */
  const draft = async () => {
    setDrafting(true);
    try {
      const d = await api.draftRejection(inspectionId);
      setNotes(d.note);
      const known = REASONS.filter((r) => d.codes.includes(r.code)).map((r) => r.code);
      if (known.length) setCodes(known);
      setError(null);
    } catch (e) {
      toast.error(e, 'Could not draft a reason');
    } finally {
      setDrafting(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const chosen = REASONS.filter((r) => codes.includes(r.code));
    if (chosen.length === 0) return setError('Choose at least one reason.');
    if (needsNote && !notes.trim()) return setError('Say what is wrong.');
    // One line the inspector sees on their job list. The categories alone
    // ("checklist incomplete") do not say which answer to fix, so the note is
    // appended whenever there is one.
    const note = notes.trim();
    const heading = chosen.map((r) => r.label).join(' · ');
    onSubmit({ reason: note ? `${heading}: ${note}` : heading });
  };

  return (
    <div className="modal" onClick={onCancel}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Reject this inspection</h2>

        {/* At the top, because it fills in the form below it. Offered after the
            fields it populates, it reads as a footnote to work already done. */}
        <button className="btn aifill" type="button" onClick={draft} disabled={drafting}>
          {drafting ? 'Reading the inspection…' : 'Let AI populate this'}
        </button>

        <div className="modal-note">
          Coverage {coveragePct.toFixed(0)}%
          {gapCount > 0 && ` · ${gapCount} stretch${gapCount === 1 ? '' : 'es'} not walked`}
        </div>

        {/*
          * What the check on the review page concluded, shown here.
          *
          * Rejecting after it said the inspection looked approvable is a
          * perfectly good decision — a supervisor knows things the model does
          * not. But it is worth seeing at the moment of deciding, rather than
          * discovering later that the two records disagree. It is also the case
          * where a drafted reason is thinnest, because there was little wrong in
          * the record to write about.
          */}
        {review && review.verdict !== 'skipped' && (
          <div className={`modal-note${review.verdict === 'looks_sound' ? ' warn' : ''}`}>
            {review.verdict === 'looks_sound'
              ? 'The AI check thought this looked approvable. Rejecting is still your call — but a drafted reason may be thin.'
              : review.verdict === 'likely_reject'
                ? 'The AI check also thought this should go back.'
                : 'The AI check flagged something worth a look.'}
          </div>
        )}

        <label>
          Reasons <span className="reasonaside">choose as many as apply</span>
          <div className="reasonlist">
            {REASONS.map((r) => {
              const on = codes.includes(r.code);
              return (
                <button
                  type="button"
                  key={r.code}
                  aria-pressed={on}
                  className={`reasonopt${on ? ' on' : ''}`}
                  onClick={() => toggle(r.code)}
                >
                  {/* A tick, because a highlighted panel alone reads as "the one
                      selected" and these no longer work that way. */}
                  <span className="reasonmark">{on ? '✓' : ''}</span>
                  <span className="reasonlabel">{r.label}</span>
                  <span className="reasonhint">{r.hint}</span>
                </button>
              );
            })}
          </div>
        </label>

        <label>
          What should they do differently{needsNote ? '' : ' (optional)'}
          <textarea
            className="textarea"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {error && <div className="signin-error">{error}</div>}

        <div className="btnrow">
          <button className="btn danger" type="submit" disabled={busy}>
            {busy ? 'Rejecting…' : 'Reject and send back'}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
