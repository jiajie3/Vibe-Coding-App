import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import CompleteFollowUp from '../components/CompleteFollowUp.tsx';
import SendBackFollowUp from '../components/SendBackFollowUp.tsx';
import { api, dueLabel } from '../api.ts';
import type { JobRecord, Overview, WorkOrder, WorkOrderStatus } from '../api.ts';
import { toast } from '../toast.ts';

const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  awaiting_verification: 'Check the photos',
  done: 'Done',
  blocked: 'Cannot complete',
  cancelled: 'Cancelled',
};

/**
 * Violet for blocked, rather than another shade of red or amber.
 *
 * Open is red and in-progress amber, so both ends of that ramp are spoken for.
 * Blocked is not "more urgent" — it is a different kind of thing: the party it
 * went to has replied that they cannot act, and it needs a decision here rather
 * than more waiting. A colour outside the ramp is what says that at a glance.
 */
const STATUS_COLOUR: Record<WorkOrderStatus, string> = {
  open: '#dc2626',
  in_progress: '#d97706',
  // Blue: this one is waiting on *you*, not on them. It is the only status in
  // the list that a supervisor can clear without chasing anybody.
  awaiting_verification: '#2563eb',
  done: '#16a34a',
  blocked: '#7c3aed',
  cancelled: '#94a3b8',
};


export default function WorkOrders() {
  const [data, setData] = useState<Overview | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [closing, setClosing] = useState<WorkOrder | null>(null);
  const [sendingBack, setSendingBack] = useState<WorkOrder | null>(null);

  const pull = useCallback(
    () => api.overview().then(setData).catch(() => {}),
    [],
  );
  useEffect(() => {
    void pull();
  }, [pull]);

  const jobsById = useMemo(
    () => new Map((data?.jobs ?? []).map((j: JobRecord) => [j.id, j])),
    [data],
  );

  const orders = useMemo(() => {
    const all = data?.work_orders ?? [];
    // Blocked stays in the live list. It is the one status that came back from
    // outside and is waiting on somebody here — hiding it with the closed ones
    // is how a case nobody can do turns into a case nobody looks at.
    const live = showClosed
      ? all
      : all.filter(
          (w) =>
            w.status === 'open' ||
            w.status === 'in_progress' ||
            w.status === 'awaiting_verification' ||
            w.status === 'blocked',
        );
    // Soonest due first — the same rule the drain queue uses, so urgency means
    // one thing across the whole console. Undated ones sink to the bottom.
    return [...live].sort((a, b) => {
      const at = a.due_at ? Date.parse(a.due_at) : Infinity;
      const bt = b.due_at ? Date.parse(b.due_at) : Infinity;
      return at - bt || Date.parse(a.raised_at) - Date.parse(b.raised_at);
    });
  }, [data, showClosed]);

  const advance = async (w: WorkOrder, status: WorkOrderStatus, note?: string) => {
    setBusy(w.id);
    try {
      await api.updateWorkOrder(w.id, { status, closing_note: note });
      setClosing(null);
      await pull();
    } finally {
      setBusy(null);
    }
  };

  /** Reject a reported-complete case, with a message that reaches Slack. */
  const sendBack = async (w: WorkOrder, note: string) => {
    setBusy(w.id);
    try {
      await api.updateWorkOrder(w.id, { status: 'in_progress', note });
      setSendingBack(null);
      await pull();
    } catch (e) {
      toast.error(e, 'Could not send it back');
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="page"><div className="empty">Loading…</div></div>;

  const open = (data.work_orders ?? []).filter((w) => w.status === 'open').length;
  const wip = (data.work_orders ?? []).filter((w) => w.status === 'in_progress').length;
  const done = (data.work_orders ?? []).filter((w) => w.status === 'done').length;

  return (
    <div className="page">
      <div className="kpis">
        <div className="kpi warn"><div className="v">{open}</div><div className="k">Awaiting action</div></div>
        <div className="kpi active"><div className="v">{wip}</div><div className="k">In progress</div></div>
        <div className="kpi"><div className="v">{done}</div><div className="k">Completed</div></div>
      </div>

      <div className="panel">
        <header>
          <h2>Inspection follow-ups</h2>
          <button className="btn tiny" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? 'Hide closed' : 'Show closed'}
          </button>
        </header>

        {orders.length === 0 && (
          <div className="empty">
            Nothing outstanding. Follow-ups come from a submitted inspection — open a
            drain with findings and use <strong>Route to officer</strong>.
          </div>
        )}

        {orders.map((w) => {
          const job = jobsById.get(w.job_id);
          return (
            <div key={w.id} className="jobrow">
              <div className="top">
                <span className="ref">{job?.reference ?? w.job_id.slice(0, 8)}</span>
                <span className="pill" style={{ background: STATUS_COLOUR[w.status] }}>
                  {STATUS_LABEL[w.status]}
                </span>
              </div>
              <div className="name">{w.detail || w.title}</div>
              <div className="meta">
                {w.assigned_to && (
                  <>
                    <strong>→ {w.assigned_to}</strong>
                    <span>·</span>
                  </>
                )}
                {job && <Link to={`/jobs/${job.id}`}>{job.asset.name}</Link>}
                {w.chainage_m != null && (
                  <>
                    <span>·</span>
                    <span>chainage {w.chainage_m.toFixed(0)} m</span>
                  </>
                )}
                <span>·</span>
                {w.due_at ? (
                  <span className={`due-${dueLabel(w.due_at).severity}`}>
                    {dueLabel(w.due_at).text}
                  </span>
                ) : (
                  <span>no due date</span>
                )}
                <span>·</span>
                <span>raised {new Date(w.raised_at).toLocaleDateString()}</span>
              </div>

              {(w.slack || w.acknowledged_at) && (
                <div className="meta" style={{ marginTop: 6 }}>
                  {w.slack && <span>opened in {w.slack.channel}</span>}
                  {w.slack && w.acknowledged_at && <span>·</span>}
                  {w.acknowledged_at ? (
                    <span>
                      acknowledged {new Date(w.acknowledged_at).toLocaleDateString()}
                    </span>
                  ) : (
                    w.slack && <span>not yet acknowledged</span>
                  )}
                  {(w.completion_attachment_ids?.length ?? 0) > 0 && (
                    <>
                      <span>·</span>
                      <span>
                        {w.completion_attachment_ids!.length} photo
                        {w.completion_attachment_ids!.length === 1 ? '' : 's'} returned
                      </span>
                    </>
                  )}
                </div>
              )}

              {(w.completion_attachment_ids?.length ?? 0) > 0 && (
                <div className="photos" style={{ marginTop: 8 }}>
                  {w.completion_attachment_ids!.map((id) => (
                    <a
                      key={id}
                      className="photo"
                      href={`/uploads/${id}.jpg`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img src={`/uploads/${id}.jpg`} alt="Work reported complete" />
                    </a>
                  ))}
                </div>
              )}

              {w.sent_back_note && w.status !== 'done' && (
                <div className="note" style={{ marginTop: 8 }}>
                  <strong>Sent back:</strong> {w.sent_back_note}
                </div>
              )}

              {w.blocked_reason && (
                <div className="note" style={{ marginTop: 8 }}>
                  <strong>Cannot complete:</strong> {w.blocked_reason}
                </div>
              )}

              {w.closing_note && (
                <div className="note" style={{ marginTop: 8 }}>{w.closing_note}</div>
              )}

              {w.status === 'awaiting_verification' && (
                <div className="rowactions">
                  <button
                    className="btn tiny primary"
                    disabled={busy === w.id}
                    onClick={() => advance(w, 'done')}
                  >
                    Photos check out — close it
                  </button>
                  <button
                    className="btn tiny"
                    disabled={busy === w.id}
                    onClick={() => setSendingBack(w)}
                  >
                    Send back
                  </button>
                </div>
              )}

              {(w.status === 'open' || w.status === 'in_progress' || w.status === 'blocked') && (
                <div className="rowactions">
                  {w.status === 'open' && (
                    <button
                      className="btn tiny"
                      disabled={busy === w.id}
                      onClick={() => advance(w, 'in_progress')}
                    >
                      Start work
                    </button>
                  )}
                  <button
                    className="btn tiny primary"
                    disabled={busy === w.id}
                    onClick={() => setClosing(w)}
                  >
                    Mark done
                  </button>
                  <button
                    className="btn tiny"
                    disabled={busy === w.id}
                    onClick={() => advance(w, 'cancelled')}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {sendingBack && (
        <SendBackFollowUp
          order={sendingBack}
          jobName={jobsById.get(sendingBack.job_id)?.asset.name}
          busy={busy === sendingBack.id}
          onCancel={() => setSendingBack(null)}
          onSubmit={(note) => sendBack(sendingBack, note)}
        />
      )}

      {closing && (
        <CompleteFollowUp
          order={closing}
          jobName={jobsById.get(closing.job_id)?.asset.name}
          busy={busy === closing.id}
          onCancel={() => setClosing(null)}
          onSubmit={(note) => advance(closing, 'done', note)}
        />
      )}
    </div>
  );
}
