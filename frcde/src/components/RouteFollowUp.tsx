import { useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import type { SuggestResponse } from '../api.ts';

/**
 * Route an inspection finding to whoever will act on it.
 *
 * Three fields, because that is what the decision actually is: what needs doing,
 * who does it, by when. Severity and a separate title were asked for earlier and
 * turned out to be ceremony — the summary is derivable from the description, and
 * the due date carries the urgency.
 *
 * A fourth thing is proposed rather than asked: which Slack channel the case is
 * opened in. FRCDE suggests one from who it is routed to and where the drain is,
 * shows its reasoning, and lets the supervisor pick differently — routing a
 * blockage to the wrong contractor costs a week, and the person raising it knows
 * things the rules do not.
 */

export interface FollowUpDraft {
  detail: string;
  assigned_to: string;
  due_at: string | null;
  chainage_m: number | null;
  /** Empty string means: record it, but do not open a case in Slack. */
  slack_channel: string;
}

/** Default: a week out, which is the same window the drain queue uses. */
function inDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const CONFIDENCE_NOTE: Record<SuggestResponse['suggestion']['confidence'], string> = {
  high: 'Confident',
  medium: 'Best guess',
  low: 'No idea — please check',
};

export default function RouteFollowUp({
  jobId,
  suggestion,
  busy,
  onCancel,
  onSubmit,
}: {
  jobId: string;
  suggestion: { detail: string; chainage_m: number | null } | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: FollowUpDraft) => void;
}) {
  const [detail, setDetail] = useState(suggestion?.detail ?? '');
  const [officer, setOfficer] = useState('');
  const [dueAt, setDueAt] = useState(inDays(7));
  const [error, setError] = useState<string | null>(null);

  const [routing, setRouting] = useState<SuggestResponse | null>(null);
  /** Set once the supervisor picks for themselves; suggestions stop overriding it. */
  const [chosen, setChosen] = useState<string | null>(null);

  /**
   * Re-ask as the officer field is typed, but not on every keystroke.
   *
   * The answer depends on that text, so it has to follow it; without the delay a
   * supervisor typing "Ang Mo Kio Town Council" watches the channel flicker
   * through four wrong answers, which teaches them not to trust it.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api
        .suggestChannel({ job_id: jobId, assigned_to: officer, severity: 3 })
        .then(setRouting)
        .catch(() => setRouting(null));
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId, officer]);

  const channel = chosen ?? routing?.suggestion.channel ?? '';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail.trim()) return setError('Say what needs doing.');
    if (!officer.trim()) return setError('Name the officer this goes to.');
    onSubmit({
      detail: detail.trim(),
      assigned_to: officer.trim(),
      due_at: dueAt ? new Date(`${dueAt}T09:00:00`).toISOString() : null,
      chainage_m: suggestion?.chainage_m ?? null,
      slack_channel: channel,
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

        <label>
          Open the case in
          <select
            className="input"
            value={channel}
            onChange={(e) => setChosen(e.target.value)}
          >
            {routing?.channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="">Do not open a Slack case</option>
          </select>
        </label>

        {routing && channel !== '' && (
          <div className="modal-note">
            <strong>{CONFIDENCE_NOTE[routing.suggestion.confidence]}.</strong>{' '}
            {chosen && chosen !== routing.suggestion.channel
              ? `FRCDE would have suggested ${routing.suggestion.channel} — ${routing.suggestion.reason}`
              : routing.suggestion.reason}
            {!routing.slack_configured && (
              <>
                {' '}
                No workspace is connected, so this will be recorded and logged
                rather than actually posted.
              </>
            )}
          </div>
        )}

        {channel === '' && (
          <div className="modal-note">
            The follow-up is still recorded here — nobody outside FRCDE will be told
            about it.
          </div>
        )}

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
