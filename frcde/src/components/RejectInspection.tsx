import { useState } from 'react';

/**
 * Reject an inspection, with a reason the inspector will read.
 *
 * This used to be a browser `prompt()`. The text goes straight to the person who
 * walked the drain and tells them what to do differently — it deserves more than
 * a one-line box with no context about what they submitted.
 *
 * The reason codes are the things reviewers actually send work back for; the
 * notes are what makes it actionable.
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
  busy,
  onCancel,
  onSubmit,
}: {
  coveragePct: number;
  gapCount: number;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: RejectionDraft) => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const chosen = REASONS.find((r) => r.code === code);
    if (!chosen) return setError('Choose a reason.');
    if (!notes.trim()) return setError('Tell the inspector what to do differently.');
    // One sentence the inspector sees on their job list — the category alone
    // ("checklist incomplete") does not tell them which answer to fix.
    onSubmit({ reason: `${chosen.label}: ${notes.trim()}` });
  };

  return (
    <div className="modal" onClick={onCancel}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Reject this inspection</h2>
        <p className="modal-sub">
          It goes back to the inspector with your reason and reappears on their job
          list. Their original submission is kept in full.
        </p>

        <div className="modal-note">
          Coverage {coveragePct.toFixed(0)}%
          {gapCount > 0 && ` · ${gapCount} stretch${gapCount === 1 ? '' : 'es'} not walked`}
        </div>

        <label>
          Reason
          <div className="reasonlist">
            {REASONS.map((r) => (
              <button
                type="button"
                key={r.code}
                className={`reasonopt${code === r.code ? ' on' : ''}`}
                onClick={() => {
                  setCode(r.code);
                  setError(null);
                }}
              >
                <span className="reasonlabel">{r.label}</span>
                <span className="reasonhint">{r.hint}</span>
              </button>
            ))}
          </div>
        </label>

        <label>
          What should they do differently
          <textarea
            className="textarea"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="The last 120 m was not walked — please cover from chainage 490 to the outfall."
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
