import { useState } from 'react';

import type { WorkOrder } from '../api.ts';

/**
 * Close out a follow-up.
 *
 * This used to be `prompt('Closing note (optional)')` — a bare box with no
 * indication of what was being closed, and an optional note, so most would have
 * been closed with nothing recorded at all.
 *
 * What was done is the only durable evidence that remediation happened. Six
 * months later, "cleared by jetting crew, 300 mm silt removed" is the difference
 * between a maintenance history and a list of ticks.
 */

const OUTCOMES = [
  { code: 'completed', label: 'Work completed', hint: 'Done as described' },
  { code: 'partial', label: 'Partially completed', hint: 'Some of it done — say what remains' },
  { code: 'not_required', label: 'Not required', hint: 'Inspected and found not to need work' },
  { code: 'referred', label: 'Referred elsewhere', hint: 'Passed to another team or agency' },
];

export default function CompleteFollowUp({
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
  const [outcome, setOutcome] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const chosen = OUTCOMES.find((o) => o.code === outcome);
    if (!chosen) return setError('Choose an outcome.');
    if (!note.trim()) return setError('Record what was actually done.');
    onSubmit(`${chosen.label}: ${note.trim()}`);
  };

  const overdue = order.due_at && Date.parse(order.due_at) < Date.now();

  return (
    <div className="modal" onClick={onCancel}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Close this follow-up</h2>

        {/* What is being closed. The old prompt gave no context at all, which
            made it easy to close the wrong one from a long list. */}
        <div className="modal-note">
          <strong>{order.detail || order.title}</strong>
          <br />
          {jobName && <>{jobName} · </>}
          routed to {order.assigned_to || 'unassigned'}
          {order.due_at && (
            <> · due {new Date(order.due_at).toLocaleDateString()}{overdue ? ' (overdue)' : ''}</>
          )}
        </div>

        <label>
          Outcome
          <div className="reasonlist">
            {OUTCOMES.map((o) => (
              <button
                type="button"
                key={o.code}
                className={`reasonopt${outcome === o.code ? ' on' : ''}`}
                onClick={() => {
                  setOutcome(o.code);
                  setError(null);
                }}
              >
                <span className="reasonlabel">{o.label}</span>
                <span className="reasonhint">{o.hint}</span>
              </button>
            ))}
          </div>
        </label>

        <label>
          What was done
          <textarea
            className="textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Jetted from chainage 150 to the outfall; approx 300 mm silt removed. Flow restored."
          />
        </label>

        {error && <div className="signin-error">{error}</div>}

        <div className="btnrow">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Closing…' : 'Close follow-up'}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
