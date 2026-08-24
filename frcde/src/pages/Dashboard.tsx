import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import DrainMap from '../components/DrainMap.tsx';
import type { MapLayer, MapPin } from '../components/DrainMap.tsx';
import {
  api,
  auth,
  AuthError,
  dueLabel,
  DISPATCHED,
  DUE_COLOUR,
  emphasis,
  jobStatusColour,
  jobStatusLabel,
  openFollowUps,
  STATUS_COLOUR,
} from '../api.ts';
import type { JobRecord, Overview } from '../api.ts';
import { toast } from '../toast.ts';
import Confirm from '../components/Confirm.tsx';

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
  const [resetting, setResetting] = useState(false);
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
      toast.error(e, 'Action failed');
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

  /** Jobs with a case still open somewhere outside FRCDE. */
  const followUps = useMemo(() => openFollowUps(data?.work_orders ?? []), [data]);

  /** A job as the pills should read it, follow-up state included. */
  const withFollowUp = useCallback(
    <T extends { id: string }>(job: T) => ({ ...job, awaiting_follow_up: followUps.has(job.id) }),
    [followUps],
  );

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

  /*
   * Coloured by when a drain is due, not by what status its job is in.
   *
   * The legend has always described due-ness — overdue, due soon, later — while
   * the map underneath was grouping by job status and colouring from a different
   * table. The two happened to look similar and meant different things, so a
   * drain pushed into the queue changed colour for reasons the legend could not
   * explain.
   *
   * `emphasis` and `DUE_COLOUR` are the same ones the job rows and the phone
   * use, so a colour means one thing across the whole system.
   *
   * Drawn later → soon → overdue, so the urgent ones sit on top where two drains
   * overlap. The closed network stays thinner: it is the estate underneath, and
   * it was once drawn in near-white at 3px, which is invisible over OSM tiles.
   */
  const layers: MapLayer[] = useMemo(() => {
    const buckets = new Map<string, number[][][]>();
    for (const j of [...notQueued, ...dispatched]) {
      const sev = emphasis(j);
      const list = buckets.get(sev) ?? [];
      list.push(j.asset.geometry.coordinates);
      buckets.set(sev, list);
    }
    return (['later', 'soon', 'overdue'] as const)
      .map((sev) => ({
        id: sev,
        lines: buckets.get(sev) ?? [],
        colour: DUE_COLOUR[sev],
        width: sev === 'later' ? 4 : 7,
      }))
      .filter((l) => l.lines.length > 0);
  }, [dispatched, notQueued]);

  const popupFor = useCallback(
    (j: JobRecord, extra = '') => {
      const due = dueLabel(j.due_at);
      return (
        `<div class="pop-ref">${esc(j.reference)}</div>` +
        `<div class="pop-name">${esc(j.asset.name)}</div>` +
        `<div class="pop-row"><span>Status</span><span>${esc(jobStatusLabel(withFollowUp(j)))}</span></div>` +
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
  const overdue = dispatched.filter((j) => dueLabel(j.due_at).overdue).length;
  const dueSoon = dispatched.filter((j) => emphasis(j) === 'soon').length;

  // Two queues, counted apart. A drain routed to a contractor is not work a
  // supervisor is behind on, and adding it to "Awaiting review" made the number
  // they check every morning wrong in the direction that causes chasing.
  const submitted = data.jobs.filter((j) => j.status === 'submitted');
  const awaitingFollowUp = submitted.filter((j) => followUps.has(j.id)).length;
  const awaitingReview = submitted.length - awaitingFollowUp;

  return (
    <div className="page">
      {/*
        * Five numbers, not seven.
        *
        * Every figure used to be the same size, so "Drains: 40" shouted as loudly
        * as "Overdue: 1" — and a dashboard where everything is emphasised has
        * nothing emphasised. The total leads because it is what the others are
        * counted out of, and it is left uncoloured so the ones that need acting
        * on are still the ones that catch the eye.
        */}
      <div className="kpis">
        <div className="kpi">
          <div className="v">{s.total}</div>
          <div className="k">Drains</div>
        </div>
        <div className="kpi warn">
          <div className="v">{overdue}</div>
          <div className="k">Overdue</div>
        </div>
        <div className="kpi soon">
          <div className="v">{dueSoon}</div>
          <div className="k">Due soon</div>
        </div>
        <div className="kpi review">
          <div className="v">{awaitingReview}</div>
          <div className="k">Awaiting review</div>
        </div>
        <div className="kpi followup">
          <div className="v">{awaitingFollowUp}</div>
          <div className="k">Awaiting follow-ups</div>
        </div>
      </div>


      {resetting && (
        <Confirm
          title="Reset the demo?"
          confirmLabel="Delete everything"
          onCancel={() => setResetting(false)}
          onConfirm={() => {
            void api
              .reset()
              .then(() => location.reload())
              .catch((e) => {
                toast.error(e, 'Could not reset');
                setResetting(false);
              });
          }}
        >
          Deletes every inspection, photograph and follow-up, and puts the 40 drains
          back to five due for inspection. Accounts and passwords are kept. This
          cannot be undone.
        </Confirm>
      )}

      <div className="split dashsplit">
        <div className="panel">
          <header>
            <h2>Drain network</h2>
          </header>
          <div className="maprow">
            <DrainMap layers={layers} pins={allPins} fitTo={fitTo} />
          </div>
          {/* Three entries, and the map uses these exact colours — from the
              same DUE_COLOUR table, so the legend cannot drift from what is
              drawn. */}
          <div className="legend">
            <span><i style={{ background: DUE_COLOUR.overdue }} />Overdue</span>
            <span><i style={{ background: DUE_COLOUR.soon }} />Due soon</span>
            <span><i style={{ background: DUE_COLOUR.later }} />Not due</span>
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
            <button className="btn tiny" onClick={() => setResetting(true)}>
              Reset
            </button>
          </div>
          {/* Evidence that the queue maintains itself. A supervisor should be
              able to see the scheduler is running, not be asked to run it. */}
          {data.scheduler && (
            <div className="schedbar">Auto-scheduling on</div>
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
                job={withFollowUp(j)}
                busy={busy === j.id}
                onOpen={() => nav(`/jobs/${j.id}`)}
                onDispatch={() => act(() => api.dispatch(j.id), j.id)}
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
  /** With `awaiting_follow_up` folded in, so the pill can read the whole state. */
  job: JobRecord & { awaiting_follow_up?: boolean };
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
        {/* Name and status on one line. The inspection reference used to sit
            above them, which cost a row in a list that scrolls and told a
            supervisor nothing they were scanning for — they look for the drain,
            not for INS-2026-004017. It is still on the drain's own page. */}
        <div className="top">
          <div className="name">{job.asset.name}</div>
          <span className="pill" style={{ background: jobStatusColour(job) }}>
            {jobStatusLabel(job)}
          </span>
        </div>
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
