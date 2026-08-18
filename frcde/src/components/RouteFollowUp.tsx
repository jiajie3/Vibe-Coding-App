import { useState } from 'react';

/**
 * Route an inspection finding to whoever will act on it.
 *
 * Three fields, because that is what the decision actually is: what needs doing,
 * who does it, by when. Severity and a separate title were asked for earlier and
 * turned out to be ceremony — the summary is derivable from the description, and
 * the due date carries the urgency.
 */

export interface FollowUpDraft {
  detail: string;
  assigned_to: string;
  due_at: string | null;
  chainage_m: number | null;
}

/** Default: a week out, which is the same window the drain queue uses. */
function inDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export default function RouteFollowUp({
  suggestion,
  busy,
  onCancel,
  onSubmit,
}: {
  suggestion: { detail: string; chainage_m: number | null } | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: FollowUpDraft) => void;
}) {
  const [detail, setDetail] = useState(suggestion?.detail ?? '');
  const [officer, setOfficer] = useState('');
  const [dueAt, setDueAt] = useState(inDays(7));
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail.trim()) return setError('Say what needs doing.');
    if (!officer.trim()) return setError('Name the officer this goes to.');
    onSubmit({
      detail: detail.trim(),
      assigned_to: officer.trim(),
      due_at: dueAt ? new Date(`${dueAt}T09:00:00`).toISOString() : null,
      chainage_m: suggestion?.chainage_m ?? null,
    });
  };

  return (
    <div className="modal" onClick={onCancel}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Route to officer for follow-up</h2>
        <p className="modal-sub">
          {suggestion?.detail
            ? 'Pre-filled from this inspection. Edit anything that is not right.'
            : 'Describe what needs doing, and who should do it.'}
        </p>

        <label>
          Details
          <textarea
            className="textarea"
            rows={4}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Blockage reported at the downstream end — approx 260 mm silt. Jetting required."
            autoFocus
          />
        </label>

        <label>
          Officer
          <input
            className="input"
            value={officer}
            onChange={(e) => setOfficer(e.target.value)}
            placeholder="Name, team or contractor"
          />
        </label>

        <label>
          Due date
          <input
            className="input"
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </label>

        {suggestion?.chainage_m != null && (
          <div className="modal-note">
            Located at chainage {suggestion.chainage_m.toFixed(0)} m, taken from the
            inspection's own photograph.
          </div>
        )}

        {error && <div className="signin-error">{error}</div>}

        <div className="btnrow">
          <button className="btn dark" type="submit" disabled={busy}>
            {busy ? 'Routing…' : 'Route for follow-up'}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
