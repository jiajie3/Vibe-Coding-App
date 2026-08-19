import { useState } from 'react';

import type { WorkOrder } from '../api.ts';

/**
 * Send a reported-complete follow-up back to whoever did it.
 *
 * The message is not optional. Sending work back with nothing said leaves the
 * contractor guessing at what was wrong, and the likeliest response to a guess
 * is the same work reported complete a second time. It goes straight into the
 * Slack thread they are already reading, under the photographs being rejected.
 */

const REASONS = [
  {
    code: 'unclear',
    label: 'Photographs do not show it',
    hint: 'Too dark, too close, or not the right stretch',
  },
  {
    code: 'incomplete',
    label: 'Work looks unfinished',
    hint: 'Some of it done — say what is left',
  },
  {
    code: 'wrong_place',
    label: 'Wrong location',
    hint: 'Not the chainage the inspection reported',
  },
  {
    code: 'other',
    label: 'Something else',
    hint: 'Explain below',
  },
];

export default function SendBackFollowUp({
  order,
  jobName,
  busy,
  onCancel,
  onSubmit,
}: {
  order: WorkOrder;
  jobName?: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const chosen = REASONS.find((r) => r.code === reason);
    if (!chosen) return setError('Choose why it is going back.');
    if (!note.trim()) return setError('Say what needs doing differently.');
    onSubmit(
      chosen.code === 'other' ? note.trim() : `${chosen.label}: ${note.trim()}`,
    );
  };

  const photos = order.completion_attachment_ids?.length ?? 0;

  return (
    <div className="modal" onClick={onCancel}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Send this back</h2>

        <div className="modal-note">
          <strong>{order.detail || order.title}</strong>
          <br />
          {jobName && <>{jobName} · </>}
          {order.assigned_to || 'unassigned'}
          {photos > 0 && <> · {photos} photo{photos === 1 ? '' : 's'} returned</>}
        </div>

        <label>
          Why
          <div className="reasonlist">
            {REASONS.map((r) => (
              <button
                type="button"
                key={r.code}
                className={`reasonopt${reason === r.code ? ' on' : ''}`}
                onClick={() => {
                  setReason(r.code);
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
          Message to {order.assigned_to || 'them'}
          <textarea
            className="textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="The photo shows the upstream end. We need the stretch around chainage 260 m, where the blockage was reported."
          />
        </label>

        <div className="modal-note">
          This is posted in the Slack case thread, and the case goes back to them
          with the Completed option available again.
        </div>

        {error && <div className="signin-error">{error}</div>}

        <div className="btnrow">
          <button className="btn dark" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send back'}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
