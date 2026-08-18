import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import DrainMap from '../components/DrainMap.tsx';
import type { MapLayer, MapPin } from '../components/DrainMap.tsx';
import {
  api,
  auth,
  AuthError,
  dueLabel,
  FLAG_WITHIN_DAYS,
  jobStatusColour,
  jobStatusLabel,
  STATUS_COLOUR,
} from '../api.ts';
import type { JobRecord, Overview } from '../api.ts';

const DISPATCHED = ['available', 'accepted', 'in_progress', 'submitted'];

/**
 * How loudly a drain's deadline should read.
 *
 * The date decides the level, but only for drains actually in the queue. A
 * closed drain still carries a due date and would otherwise render as "overdue
 * by 3d" in red — alarming about work nobody is expected to do, and drowning out
 * the queued drains that genuinely are late.
 */
const emphasis = (j: JobRecord) =>
  DISPATCHED.includes(j.status) ? dueLabel(j.due_at).severity : 'later';

function relativeTime(iso: string): string {
  const secs = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (secs < 90) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Midpoint of the alignment — where the drain's pin sits. */
function midpoint(coords: number[][]): [number, number] {
  const c = coords[Math.floor(coords.length / 2)];
  return [c[0], c[1]];
}

type Filter = 'due' | 'all';
type Sort = 'due' | 'name' | 'length';

const SORT_LABEL: Record<Sort, string> = {
  due: 'Due date (soonest)',
  name: 'Name (A–Z)',
  length: 'Length (longest)',
};

export default function Dashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Defaults to the whole register — the queue is a filter on it, not the
  // starting point. A supervisor opens this to see the estate.
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('due');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const nav = useNavigate();

  /**
   * Poll, but keep the old object when nothing actually changed.
   *
   * The response is deep-equal most of the time, yet arrives as fresh objects —
   * which would invalidate every memo and make the map tear down and rebuild all
   * 40 markers every five seconds, closing any popup mid-read.
   */
  const pull = useCallback(async () => {
    try {
      const next = await api.overview();
      setData((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setError(null);
    } catch (e) {
      // "Cannot reach the API" and "your session expired" need completely
      // different responses, and reporting the second as the first sent us
      // looking for a dead server that was running perfectly well.
      if (e instanceof AuthError) {
        auth.clear();
        location.reload();
        return;
      }
      setError(e instanceof Error ? e.message : 'Request failed');
    }
  }, []);

  useEffect(() => {
    void pull();
    // Polling rather than websockets: a supervisor watching the console wants
    // submissions to appear without a refresh, and 5 s is plenty for a mockup.
    const t = setInterval(() => void pull(), 5000);
    return () => clearInterval(t);
  }, [pull]);

  const act = async (fn: () => Promise<unknown>, id: string) => {
    setBusy(id);
    try {
      await fn();
      await pull();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Free-text match across the things a supervisor actually knows a drain by:
   * its name, its job reference, or its asset id. Applied before every other
   * filter so the map and the list narrow together — searching and then
   * hunting for the result on an unchanged map would be worse than useless.
   */
  const matches = useCallback(
    (j: JobRecord) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        j.asset.name.toLowerCase().includes(q) ||
        j.reference.toLowerCase().includes(q) ||
        j.asset.id.toLowerCase().includes(q) ||
        j.asset.type.replace(/_/g, ' ').includes(q)
      );
    },
    [query],
  );

  const visible = useMemo(() => (data?.jobs ?? []).filter(matches), [data, matches]);

  const dispatched = useMemo(
    () => visible.filter((j) => DISPATCHED.includes(j.status)),
    [visible],
  );

  const shown = useMemo(() => {
    const list = [...(filter === 'due' ? dispatched : visible)];
    switch (sort) {
      case 'name':
        return list.sort((a, b) => a.asset.name.localeCompare(b.asset.name));
      case 'length':
        return list.sort((a, b) => b.asset.length_m - a.asset.length_m);
      default:
        // Closed drains carry a due date but no obligation, so they sink below
        // live ones rather than interleaving with real deadlines.
        return list.sort((a, b) => {
          const live = (j: JobRecord) => (DISPATCHED.includes(j.status) ? 0 : 1);
          return live(a) - live(b) || Date.parse(a.due_at) - Date.parse(b.due_at);
        });
    }
  }, [filter, sort, dispatched, visible]);

  /** Closed drains — shown unless the queue-only filter is on. */
  const notQueued = useMemo(
    () => (filter === 'due' ? [] : visible.filter((j) => !DISPATCHED.includes(j.status))),
    [visible, filter],
  );

  /* The estate underneath, today's work on top. The closed network was
     previously drawn in near-white at 3px, which is invisible over OSM raster
     tiles — it needs enough contrast to read as a real layer. */
  const layers: MapLayer[] = useMemo(() => {
    const out: MapLayer[] = [
      {
        id: 'network',
        lines: notQueued.map((j) => j.asset.geometry.coordinates),
        colour: '#7c8da3',
        width: 4,
      },
    ];
    const byStatus = new Map<string, number[][][]>();
    for (const j of dispatched) {
      const list = byStatus.get(j.status) ?? [];
      list.push(j.asset.geometry.coordinates);
      byStatus.set(j.status, list);
    }
    for (const [status, lines] of byStatus) {
      out.push({ id: status, lines, colour: STATUS_COLOUR[status] ?? '#64748b', width: 7 });
    }
    return out;
  }, [dispatched, notQueued]);

  const popupFor = useCallback(
    (j: JobRecord, extra = '') => {
      const due = dueLabel(j.due_at);
      return (
        `<div class="pop-ref">${esc(j.reference)}</div>` +
        `<div class="pop-name">${esc(j.asset.name)}</div>` +
        `<div class="pop-row"><span>Status</span><span>${esc(jobStatusLabel(j))}</span></div>` +
        `<div class="pop-row"><span>Length</span><span>${j.asset.length_m.toFixed(0)} m</span></div>` +
        `<div class="pop-row"><span>Due</span><span>${due.text}</span></div>` +
        extra +
        `<div class="pop-hint">Click to open</div>`
      );
    },
    [],
  );

  const pins: MapPin[] = useMemo(
    () =>
      dispatched.map((j) => {
        const [lon, lat] = midpoint(j.asset.geometry.coordinates);
        const due = dueLabel(j.due_at);
        const hb = j.heartbeat
          ? `<div class="pop-row"><span>Progress</span><span>${j.heartbeat.coverage_pct.toFixed(0)}% · ${j.heartbeat.status === 'paused' ? 'paused' : 'walking'}</span></div>`
          : '';
        // Red for late, amber for due soon, calm for everything else — the same
        // three states the list uses, so map and list never disagree.
        const sev = emphasis(j);
        return {
          id: j.id,
          lon,
          lat,
          colour:
            sev === 'overdue' ? '#dc2626'
            : sev === 'soon' ? '#f59e0b'
            : (STATUS_COLOUR[j.status] ?? '#64748b'),
          size: sev === 'overdue' ? 28 : sev === 'soon' ? 24 : 16,
          pulse: due.overdue,
          onClick: () => nav(`/jobs/${j.id}`),
          html: popupFor(j, hb),
        };
      }),
    [dispatched, nav, popupFor],
  );

  /**
   * Closed drains get their own markers.
   *
   * Small and muted so they stay background, but present — a line with nothing
   * to hover or click is not really on the map, and finding a drain in order to
   * queue it was the thing you could not do.
   */
  const networkPins: MapPin[] = useMemo(
    () =>
      notQueued.map((j) => {
        const [lon, lat] = midpoint(j.asset.geometry.coordinates);
        return {
          id: j.id,
          lon,
          lat,
          colour: '#7c8da3',
          size: 11,
          onClick: () => nav(`/jobs/${j.id}`),
          html: popupFor(j, '<div class="pop-row"><span>Not in the queue</span><span></span></div>'),
        };
      }),
    [notQueued, nav, popupFor],
  );

  const allPins = useMemo(() => [...networkPins, ...pins], [networkPins, pins]);

  const fitTo = useMemo(
    () => (data?.jobs ?? []).flatMap((j) => j.asset.geometry.coordinates),
    [data],
  );

  if (error) {
    return (
      <div className="page">
        <div className="panel">
          <div className="empty">
            <strong>Cannot reach the FRCDE API.</strong>
            <br />
            {error}
            <br />
            <br />
            Start it with <code>npm run dev</code> in the <code>frcde</code> folder.
          </div>
        </div>
      </div>
    );
  }

  if (!data) return <div className="page"><div className="empty">Loading…</div></div>;

  const s = data.stats;

  return (
    <div className="page">
      <div className="kpis">
        <div className="kpi"><div className="v">{s.total}</div><div className="k">Drains</div></div>
        <div className="kpi"><div className="v">{dispatched.length}</div><div className="k">Due for inspection</div></div>
        <div className="kpi warn">
          <div className="v">{dispatched.filter((j) => dueLabel(j.due_at).overdue).length}</div>
          <div className="k">Overdue</div>
        </div>
        <div className="kpi soon">
          <div className="v">
            {dispatched.filter((j) => dueLabel(j.due_at).severity === 'soon').length}
          </div>
          <div className="k">Due within {FLAG_WITHIN_DAYS}d</div>
        </div>
        <div className="kpi active"><div className="v">{s.in_progress}</div><div className="k">In progress</div></div>
        <div className="kpi review"><div className="v">{s.submitted}</div><div className="k">Awaiting review</div></div>
        <div className="kpi"><div className="v">{s.approved}</div><div className="k">Closed</div></div>
      </div>

      <div className="split">
        <div className="panel">
          <header>
            <h2>Drain network</h2>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {dispatched.length} queued
              {filter === 'all'
                ? ` · ${notQueued.length} not queued · hover any marker`
                : ' · closed drains hidden'}
            </span>
          </header>
          <div className="maprow">
            <DrainMap layers={layers} pins={allPins} fitTo={fitTo} />
          </div>
          <div className="legend">
            <span><i style={{ background: '#dc2626' }} />Overdue</span>
            <span><i style={{ background: '#f59e0b' }} />Due within {FLAG_WITHIN_DAYS}d</span>
            <span><i style={{ background: '#475569' }} />Queued, due later</span>
            {filter === 'all' && (
              <span><i style={{ background: '#7c8da3' }} />Not queued — click to add</span>
            )}
          </div>
        </div>

        <div className="panel">
          <header>
            <h2>{filter === 'due' ? 'Inspection queue' : 'All drains'}</h2>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{shown.length}</span>
          </header>
          <div className="toolbar">
            <div className="searchwrap">
              <input
                className="input search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, reference or asset id"
                aria-label="Search drains"
              />
              {query && (
                <button className="searchclear" onClick={() => setQuery('')} aria-label="Clear">
                  ×
                </button>
              )}
            </div>
            <div className="segbar">
              <button
                className={filter === 'all' ? 'on' : ''}
                onClick={() => setFilter('all')}
              >
                All drains
              </button>
              <button
                className={filter === 'due' ? 'on' : ''}
                onClick={() => setFilter('due')}
              >
                Queue only
              </button>
            </div>
            <select
              className="select"
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              aria-label="Sort by"
            >
              {(Object.keys(SORT_LABEL) as Sort[]).map((k) => (
                <option key={k} value={k}>Sort: {SORT_LABEL[k]}</option>
              ))}
            </select>
            <button
              className="btn tiny"
              onClick={() => {
                if (confirm('Reset all jobs and delete every inspection?')) {
                  void api.reset().then(() => location.reload());
                }
              }}
            >
              Reset
            </button>
          </div>
          {/* Evidence that the queue maintains itself. A supervisor should be
              able to see the scheduler is running, not be asked to run it. */}
          {data.scheduler && (
            <div className="schedbar">
              Auto-scheduling on · checked {data.scheduler.checked} closed drains{' '}
              {relativeTime(data.scheduler.last_run_at)}
              {data.scheduler.queued.length > 0 &&
                ` · queued ${data.scheduler.queued.join(', ')}`}
            </div>
          )}

          <div className="queue">
            {shown.length === 0 && (
              <div className="empty">
                {query
                  ? `No drain matches “${query}”.`
                  : 'Nothing scheduled.'}
              </div>
            )}
            {shown.map((j) => (
              <QueueRow
                key={j.id}
                job={j}
                busy={busy === j.id}
                onOpen={() => nav(`/jobs/${j.id}`)}
                onDispatch={() => act(() => api.dispatch(j.id, { due_in_days: 7 }), j.id)}
                onClose={() => act(() => api.close(j.id), j.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function QueueRow({
  job,
  busy,
  onOpen,
  onDispatch,
  onClose,
}: {
  job: JobRecord;
  busy: boolean;
  onOpen: () => void;
  onDispatch: () => void;
  onClose: () => void;
}) {
  const due = dueLabel(job.due_at);
  const inPlay = DISPATCHED.includes(job.status);

  return (
    <div className="jobrow">
      <div onClick={onOpen} style={{ cursor: 'pointer' }}>
        <div className="top">
          <span className="ref">{job.reference}</span>
          <span className="pill" style={{ background: jobStatusColour(job) }}>
            {jobStatusLabel(job)}
          </span>
        </div>
        <div className="name">{job.asset.name}</div>
        <div className="meta">
          <span>{job.asset.length_m.toFixed(0)} m</span>
          <span>·</span>
          {/* Shown for every drain, queued or not — "due in 84 days" is
              information; a blank is a gap you have to go and look up.
              Red is reserved for genuinely late. */}
          <span className={`due-${emphasis(job)}`}>{due.text}</span>
          {!inPlay && (
            <>
              <span>·</span>
              <span>not queued</span>
            </>
          )}
        </div>

        {/* All FRCDE knows about an unfinished walk — the full coverage state
            stays on the handset. */}
        {job.heartbeat && (
          <>
            <div className="bar">
              <i style={{ width: `${Math.min(job.heartbeat.coverage_pct, 100)}%` }} />
            </div>
            <div className="meta">
              <span>
                {job.heartbeat.coverage_pct.toFixed(0)}% walked ·{' '}
                {job.heartbeat.status === 'paused' ? 'paused' : 'active'} ·{' '}
                {new Date(job.heartbeat.updated_at).toLocaleString()}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Deciding what gets inspected is FRCDE's job, so it has to be doable by
          a person and not only by the seed script. */}
      <div className="rowactions">
        {inPlay ? (
          <button className="btn tiny" disabled={busy} onClick={onClose}>
            {busy ? '…' : 'Remove from queue'}
          </button>
        ) : (
          <button className="btn tiny primary" disabled={busy} onClick={onDispatch}>
            {busy ? '…' : 'Add to queue'}
          </button>
        )}
      </div>
    </div>
  );
}
