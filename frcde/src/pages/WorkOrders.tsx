import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import CompleteFollowUp from '../components/CompleteFollowUp.tsx';
import { api, dueLabel } from '../api.ts';
import type { JobRecord, Overview, WorkOrder, WorkOrderStatus } from '../api.ts';

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


export default function WorkOrders() {
  const [data, setData] = useState<Overview | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [closing, setClosing] = useState<WorkOrder | null>(null);

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
    const live = showClosed ? all : all.filter((w) => w.status === 'open' || w.status === 'in_progress');
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

              {w.closing_note && (
                <div className="note" style={{ marginTop: 8 }}>{w.closing_note}</div>
              )}

              {(w.status === 'open' || w.status === 'in_progress') && (
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
