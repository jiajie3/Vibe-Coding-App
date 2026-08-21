import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api.ts';
import type { JobRecord, Overview, WorkOrderStatus } from '../api.ts';
import { toast } from '../toast.ts';

const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
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
  done: '#16a34a',
  blocked: '#7c3aed',
  cancelled: '#94a3b8',
};


/** "15 Aug" — a trail of full timestamps is unreadable at a glance. */
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export default function WorkOrders() {
  const [data, setData] = useState<Overview | null>(null);
  const [showClosed, setShowClosed] = useState(false);

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
            w.status === 'open' || w.status === 'in_progress' || w.status === 'blocked',
        );
    // Soonest due first — the same rule the drain queue uses, so urgency means
    // one thing across the whole console. Undated ones sink to the bottom.
    return [...live].sort((a, b) => {
      const at = a.due_at ? Date.parse(a.due_at) : Infinity;
      const bt = b.due_at ? Date.parse(b.due_at) : Infinity;
      return at - bt || Date.parse(a.raised_at) - Date.parse(b.raised_at);
    });
  }, [data, showClosed]);

  if (!data) return <div className="page"><div className="empty">Loading…</div></div>;

  const open = (data.work_orders ?? []).filter((w) => w.status === 'open').length;
  const wip = (data.work_orders ?? []).filter((w) => w.status === 'in_progress').length;
  const done = (data.work_orders ?? []).filter((w) => w.status === 'done').length;

  return (
    <div className="page">
      <div className="kpis">
        <div className="kpi warn"><div className="v">{open}</div><div className="k">Awaiting acknowledgement</div></div>
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
              {/* Where and who, because that is what a supervisor scans a list of
                  follow-ups for. The inspection reference told them nothing they
                  were looking for and cost the line its subject. */}
              <div className="top">
                <div className="name">
                  {job ? <Link to={`/jobs/${job.id}`}>{job.asset.name}</Link> : 'Unknown drain'}
                  {w.assigned_to && <span className="routed"> → {w.assigned_to}</span>}
                </div>
                <span className="pill" style={{ background: STATUS_COLOUR[w.status] }}>
                  {STATUS_LABEL[w.status]}
                </span>
              </div>

              {/* The description says where along the drain it is; appending
                  the same number produced "…at 84 m along the drain · 84 m". */}
              <div className="detail">{w.detail || w.title}</div>

              {/* What has happened to it, oldest first. A case is a sequence of
                  events between two organisations, and reading it as one is the
                  only way to see where it is stuck. */}
              <ol className="trail">
                <li>
                  <span className="when">{shortDate(w.raised_at)}</span>
                  Raised{w.slack ? ` and opened in ${w.slack.channel}` : ''}
                </li>
                {w.acknowledged_at ? (
                  <li>
                    <span className="when">{shortDate(w.acknowledged_at)}</span>
                    Acknowledged by {w.assigned_to || 'them'}
                  </li>
                ) : (
                  w.slack &&
                  w.status !== 'cancelled' && (
                    <li className="pending">
                      <span className="when">—</span>
                      Not yet acknowledged
                    </li>
                  )
                )}
                {w.status === 'blocked' && (
                  <li className="bad">
                    <span className="when">{shortDate(w.closed_at ?? w.raised_at)}</span>
                    Cannot complete — {w.blocked_reason || 'no reason given'}
                  </li>
                )}
                {w.status === 'done' && (
                  <li className="good">
                    <span className="when">{shortDate(w.closed_at ?? w.raised_at)}</span>
                    {w.closing_note || 'Completed'}
                    {(w.completion_attachment_ids?.length ?? 0) > 0 &&
                      ` · ${w.completion_attachment_ids!.length} photo${
                        w.completion_attachment_ids!.length === 1 ? '' : 's'
                      }`}
                  </li>
                )}
                {w.status === 'cancelled' && (
                  <li>
                    <span className="when">{shortDate(w.closed_at ?? w.raised_at)}</span>
                    Cancelled
                  </li>
                )}
              </ol>

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

            </div>
          );
        })}
      </div>

    </div>
  );
}
