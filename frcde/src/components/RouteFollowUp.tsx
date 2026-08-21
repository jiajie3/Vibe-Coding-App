import { useEffect, useState } from 'react';

import { api } from '../api.ts';
import { toast } from '../toast.ts';
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
  /** The photographs to send with the case. */
  attachment_ids: string[];
}

export default function RouteFollowUp({
  jobId,
  inspectionId,
  photos,
  suggestion,
  busy,
  onCancel,
  onSubmit,
}: {
  jobId: string;
  inspectionId: string | null;
  /** Every stored photograph from the inspection, offered for forwarding. */
  photos: { id: string; caption?: string }[];
  suggestion: { detail: string; chainage_m: number | null } | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: FollowUpDraft) => void;
}) {
  const [detail, setDetail] = useState(suggestion?.detail ?? '');
  /**
   * Every photograph, until the supervisor drops one.
   *
   * Included by default because the contractor is being asked to fix something
   * they have not seen, and the inspector already photographed it. Removable
   * because not every shot belongs in a channel a contractor reads — one may
   * show a neighbouring property, or simply not be about the work.
   */
  const [chosen, setChosen] = useState<string[]>(photos.map((p) => p.id));
  const [drafting, setDrafting] = useState(false);
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

  const channelChoice = channel ?? '';

  /**
   * Fill in what needs doing, and where the case opens.
   *
   * Routing is asked of the model rather than of routing.ts because the table
   * can only match words a supervisor typed, and at this point nobody has typed
   * anything. What kind of problem it is — something in the drain, or something
   * about the road — is a judgement about the finding itself.
   *
   * A draft. Both fields stay editable and the case is still opened by hand.
   */
  const populate = async () => {
    if (!inspectionId) return;
    setDrafting(true);
    try {
      const d = await api.draftFollowUp(inspectionId);
      setDetail(d.detail);
      setChannel(d.channel);
      setError(null);
    } catch (e) {
      toast.error(e, 'Could not draft the follow-up');
    } finally {
      setDrafting(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail.trim()) return setError('Say what needs doing.');
    onSubmit({
      detail: detail.trim(),
      slack_channel: channelChoice,
      chainage_m: suggestion?.chainage_m ?? null,
      attachment_ids: chosen,
    });
  };

  return (
    <div className="modal" onClick={onCancel}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Route for follow-up</h2>
        {inspectionId && (
          /* At the top, because it fills in the form below it. */
          <button
            className="btn aifill"
            type="button"
            onClick={populate}
            disabled={drafting}
          >
            {drafting ? 'Reading the inspection…' : 'Let AI populate this'}
          </button>
        )}

        <label>
          Details
          <textarea
            className="textarea"
            rows={4}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            autoFocus
          />
        </label>

        <label>
          Open the case in
          <select
            className="input"
            value={channelChoice}
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

        {photos.length > 0 && (
          <label>
            <span className="labelrow">
              Photographs
              <span className="hint">
                {chosen.length} of {photos.length} will be sent
              </span>
            </span>
            {/* Removable, not addable. The inspection is the source of these —
                a supervisor attaching something else here would be adding
                evidence to a record they did not gather. */}
            <div className="photos pickable">
              {photos.map((ph) => {
                const on = chosen.includes(ph.id);
                return (
                  <div key={ph.id} className={`photo${on ? '' : ' dropped'}`}>
                    <img src={`/uploads/${ph.id}.jpg`} alt={ph.caption ?? ''} />
                    <button
                      type="button"
                      className="drop"
                      aria-label={on ? 'Do not send this photograph' : 'Send this photograph'}
                      onClick={() =>
                        setChosen((c) =>
                          on ? c.filter((x) => x !== ph.id) : [...c, ph.id],
                        )
                      }
                    >
                      {on ? '×' : '+'}
                    </button>
                  </div>
                );
              })}
            </div>
          </label>
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
