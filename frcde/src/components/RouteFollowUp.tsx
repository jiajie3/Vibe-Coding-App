import { useEffect, useState } from 'react';

import { api } from '../api.ts';
import type { SuggestResponse } from '../api.ts';

/**
 * Route an inspection finding to whoever will act on it.
 *
 * Two decisions, because that is all this is: what needs doing, and where the
 * case gets opened. The channel is the party — picking `#nea` says the same
 * thing as typing "NEA", and asking for both invites them to disagree.
 *
 * A due date and a severity used to be asked for here and were dropped. Both
 * were filled in out of habit rather than judgement, and a card printing
 * "Moderate (3/5)" to a contractor states a severity nobody actually decided.
 * Absent is more honest than defaulted, and the due date the case really answers
 * to is the drain's own inspection deadline, which FRCDE already tracks.
 */

export interface FollowUpDraft {
  detail: string;
  /** Empty string means: record it, but do not open a case in Slack. */
  slack_channel: string;
  chainage_m: number | null;
}

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
  const [error, setError] = useState<string | null>(null);

  const [routing, setRouting] = useState<SuggestResponse | null>(null);
  const [channel, setChannel] = useState<string | null>(null);

  /**
   * Asked once, on open.
   *
   * It used to follow the officer field as it was typed, matching a party from
   * the text. With the field gone there is nothing to re-ask about: this now
   * fetches the channel list, and whatever the table can infer from the drain
   * itself.
   */
  useEffect(() => {
    api
      .suggestChannel({ job_id: jobId, assigned_to: '', severity: 3 })
      .then((r) => {
        setRouting(r);
        setChannel((c) => c ?? r.suggestion.channel);
      })
      .catch(() => setRouting(null));
  }, [jobId]);

  const chosen = channel ?? '';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail.trim()) return setError('Say what needs doing.');
    onSubmit({
      detail: detail.trim(),
      slack_channel: chosen,
      chainage_m: suggestion?.chainage_m ?? null,
    });
  };

  return (
    <div className="modal" onClick={onCancel}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Route for follow-up</h2>
        <p className="modal-sub">
          {suggestion?.detail
            ? 'Pre-filled from this inspection. Edit anything that is not right.'
            : 'Describe what needs doing, and where the case should be opened.'}
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
          Open the case in
          <select
            className="input"
            value={chosen}
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value="">Do not open a Slack case</option>
            {routing?.channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        {chosen !== '' && routing && (
          <div className="modal-note">
            Recorded as routed to <strong>{routing.labels[chosen] ?? chosen}</strong>.
            They acknowledge in Slack, then close it or say why they cannot.
            {!routing.slack_configured && (
              <>
                {' '}
                No workspace is connected, so this will be logged rather than
                actually posted.
              </>
            )}
          </div>
        )}

        {chosen === '' && (
          <div className="modal-note">
            The follow-up is recorded here, and nobody outside FRCDE is told about it.
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
