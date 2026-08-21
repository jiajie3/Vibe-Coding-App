import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api.ts';
import type { JobRecord, Overview, WorkOrderStatus } from '../api.ts';

const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STATUS_COLOUR: Record<WorkOrderStatus, string> = {
  open: '#dc2626',
  in_progress: '#d97706',
  done: '#16a34a',
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

  /**
   * Follow what Slack sends back, without being asked to refresh.
   *
   * Acknowledgements and completions arrive from outside this browser — a
   * contractor presses a button in a channel and nothing here would know. A
   * supervisor watching the list should see it move.
   *
   * Polled rather than streamed. A server-sent stream would be a truer "live",
   * but it holds a connection open, and on the free plan an always-open
   * connection is an instance that never sleeps and bills for hours nobody is
   * using.
   *
   * Only while the tab is actually being looked at, for the same reason: a
   * console left open on a spare monitor overnight should not keep the service
   * awake. Hidden and back again refreshes immediately, so nothing is stale by
   * the time it is read.
   */
  useEffect(() => {
    void pull();
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void pull(), 8000);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) return stop();
      void pull();
      start();
    };

    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pull]);

  const jobsById = useMemo(
    () => new Map((data?.jobs ?? []).map((j: JobRecord) => [j.id, j])),
    [data],
  );

  const orders = useMemo(() => {
    const all = data?.work_orders ?? [];
    const live = showClosed
      ? all
      : all.filter((w) => w.status === 'open' || w.status === 'in_progress');
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

        {/* Only when it is actually biting, and only saying what to do about it. */}
        {data.slack_names_blocked && (
          <div className="notice">
            Slack messages show as <strong>Slack member</strong> because the Slack app
            cannot read names
            {data.slack_names_blocked === 'missing_scope'
              ? ': add the '
              : ` (${data.slack_names_blocked}). Add the `}
            <code>users:read</code> scope and reinstall the app.
          </div>
        )}

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

              {/* What went out with the case, where a reader looks first: this
                  is part of the instruction, not part of the history. */}
              {(w.attachment_ids?.length ?? 0) > 0 && (
                <div className="photos casesent">
                  {w.attachment_ids.map((id) => (
                    <a key={id} className="photo" href={`/uploads/${id}.jpg`} target="_blank" rel="noreferrer">
                      <img
                        src={`/uploads/${id}.jpg`}
                        alt="Sent with the case"
                        onError={(e) => {
                          (e.currentTarget.closest('.photo') as HTMLElement).style.display = 'none';
                        }}
                      />
                    </a>
                  ))}
                </div>
              )}

              {/* What has happened to it, oldest first. A case is a sequence of
                  events between two organisations, and reading it as one is the
                  only way to see where it is stuck. */}
              <ol className="trail">
                <li>
                  <span className="when">{shortDate(w.raised_at)}</span>
                  Raised{w.slack ? ` and opened in ${w.slack.name ?? w.slack.channel}` : ''}
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
                {w.status === 'done' && (
                  <li className="good">
                    <span className="when">{shortDate(w.closed_at ?? w.raised_at)}</span>
                    {w.closing_note || 'Completed'}
                  </li>
                )}
                {w.status === 'cancelled' && (
                  <li>
                    <span className="when">{shortDate(w.closed_at ?? w.raised_at)}</span>
                    Cancelled
                  </li>
                )}
                {(w.thread?.length ?? 0) > 0 && (
                  <li className="said">
                    <span className="when" />
                    {/* Collapsed by default. The conversation is the detail
                        behind the case, not the case — a supervisor scanning a
                        list wants the sequence, and opens the talk when a case
                        is not where they expect it to be.

                        A native <details> rather than React state: it needs no
                        per-row bookkeeping and keeps keyboard behaviour for
                        free. */}
                    <details className="thread">
                      <summary>
                        {w.thread!.length} message{w.thread!.length === 1 ? '' : 's'} in Slack
                      </summary>
                      {w.thread!.map((m, i) => (
                        <div key={i} className={`msg ${m.from}`}>
                          {m.text && (
                            <p>
                              <span className="who">{m.who}</span>
                              {m.text}
                            </p>
                          )}
                          {/* Inside the message that carried them, in the order
                              Slack shows them. Filed anywhere else, a photograph
                              and the words that came with it read as two
                              separate things — which is what made them look
                              duplicated. */}
                          {(m.photos?.length ?? 0) > 0 && (
                            <div className="photos">
                              {m.photos!.map((id) => (
                                <a key={id} className="photo" href={`/uploads/${id}.jpg`} target="_blank" rel="noreferrer">
                                  <img
                                    src={`/uploads/${id}.jpg`}
                                    alt="Posted in the thread"
                                    onError={(e) => {
                                      (e.currentTarget.closest('.photo') as HTMLElement).style.display = 'none';
                                    }}
                                  />
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </details>
                  </li>
                )}
              </ol>

            </div>
          );
        })}
      </div>

    </div>
  );
}
