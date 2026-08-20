import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import DrainMap from '../components/DrainMap.tsx';
import type { MapLayer, MapPin } from '../components/DrainMap.tsx';
import RejectInspection from '../components/RejectInspection.tsx';
import AutoReview from '../components/AutoReview.tsx';
import RouteFollowUp from '../components/RouteFollowUp.tsx';
import type { FollowUpDraft } from '../components/RouteFollowUp.tsx';
import SiteNotes from '../components/SiteNotes.tsx';
import { api, dueLabel, jobStatusColour, jobStatusLabel } from '../api.ts';
import { toast } from '../toast.ts';

import type {
  ChecklistTemplate,
  InspectionDetail,
  JobRecord,
  WorkOrder,
} from '../api.ts';

function formatAnswer(v: unknown, field?: { options?: { value: string; label: string }[]; unit?: string }): string {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (v == null || v === '') return '—';
  const label = (x: unknown) =>
    field?.options?.find((o) => o.value === x)?.label ?? String(x).replace(/_/g, ' ');
  if (Array.isArray(v)) return v.map(label).join(', ');
  return label(v) + (field?.unit ? ` ${field.unit}` : '');
}

const titleCase = (id: string) =>
  id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** An answer worth flagging to a reviewer at a glance. */
function isConcerning(id: string, v: unknown): boolean {
  if (v === true && (id === 'blockage_present' || id.includes('defect'))) return true;
  return typeof v === 'string' && ['poor', 'critical', 'surcharged'].includes(v);
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobRecord | null>(null);
  const [inspections, setInspections] = useState<InspectionDetail[]>([]);
  const [template, setTemplate] = useState<ChecklistTemplate | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [routing, setRouting] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const d = await api.job(id);
    setJob(d.job);
    setInspections(d.inspections);
    setOrders(d.work_orders ?? []);
    api.template(d.job.checklist_template.id).then(setTemplate).catch(() => {});
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Only inspections that actually produced a result.
   *
   * `abandoned` ones were superseded before submission — real events kept in the
   * record, but noise in a review screen, and counting them made a single
   * completed inspection look like several.
   */
  const attempts = useMemo(
    () =>
      [...inspections]
        .filter((i) => i.status !== 'abandoned')
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)),
    [inspections],
  );

  const current = useMemo(
    () => attempts.find((a) => a.id === selected) ?? attempts[0] ?? null,
    [attempts, selected],
  );

  /**
   * Suggest a work order from what the inspection actually found, rather than
   * making the reviewer retype it. A blockage or a poor structural grade is
   * exactly the finding that ought to become work.
   */
  const suggestion = useMemo(() => {
    const a = (current?.checklist?.answers ?? {}) as Record<string, unknown>;
    const photo = current?.attachments.find((x) => x.chainage_m != null);
    const at = photo?.chainage_m != null ? ` at chainage ${photo.chainage_m.toFixed(0)} m` : '';

    if (a.blockage_present === true) {
      const depth = typeof a.silt_depth_mm === 'number' ? `, approx ${a.silt_depth_mm} mm silt` : '';
      const kinds = Array.isArray(a.blockage_type)
        ? ` (${(a.blockage_type as string[]).join(', ').replace(/_/g, ' ')})`
        : '';
      return {
        detail: `Clear blockage${at}${depth}${kinds}. Reported during inspection.`,
        chainage_m: photo?.chainage_m ?? null,
      };
    }
    if (a.structural_condition === 'critical' || a.structural_condition === 'poor') {
      const defects = Array.isArray(a.defect_types)
        ? ` Defects: ${(a.defect_types as string[]).join(', ').replace(/_/g, ' ')}.`
        : '';
      return {
        detail: `Structural condition reported as ${String(a.structural_condition)}${at}.${defects}`,
        chainage_m: photo?.chainage_m ?? null,
      };
    }
    return null;
  }, [current]);

  const routeFollowUp = async (draft: FollowUpDraft) => {
    if (!current || !job) return;
    setBusy(true);
    try {
      await api.createWorkOrder({
        job_id: job.id,
        inspection_id: current.id,
        ...draft,
        attachment_ids: current.attachments.map((a) => a.id),
      });
      setRouting(false);
      await load();
    } catch (e) {
      toast.error(e, 'Could not route this follow-up');
    } finally {
      setBusy(false);
    }
  };

  const layers: MapLayer[] = useMemo(() => {
    if (!job) return [];
    const base: MapLayer[] = [
      { id: 'alignment', lines: [job.asset.geometry.coordinates], colour: '#94a3b8', width: 8 },
    ];
    if (!current) return base;
    return [
      ...base,
      { id: 'covered', lines: current.covered_lines, colour: '#16a34a', width: 8 },
      { id: 'uncovered', lines: current.uncovered_lines, colour: '#dc2626', width: 8 },
      { id: 'track', lines: [current.track_line], colour: '#2563eb', width: 2.5 },
    ];
  }, [job, current]);

  const pins: MapPin[] = useMemo(
    () =>
      (current?.attachments ?? [])
        .filter((a) => a.lat != null && a.lon != null)
        .map((a) => ({
          id: a.id,
          lon: a.lon!,
          lat: a.lat!,
          colour: '#f59e0b',
          onClick: () => a.stored && setLightbox(`/uploads/${a.id}.jpg`),
          html:
            `<div class="pop-name">${a.chainage_m != null ? `Chainage ${a.chainage_m.toFixed(0)} m` : 'Photograph'}</div>` +
            (a.caption ? `<div class="pop-row"><span>${a.caption}</span></div>` : '') +
            (a.stored ? `<div class="pop-hint">Click to view</div>` : ''),
        })),
    [current],
  );

  const review = async (decision: 'approved' | 'rejected', reason?: string) => {
    if (!current) return;
    setBusy(true);
    try {
      await api.review(current.id, decision, reason);
      setRejecting(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const queueAction = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      toast.error(e, 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (!job) return <div className="page"><div className="empty">Loading…</div></div>;

  const gate = job.inspection_rules.min_coverage_pct;
  const serverPct = current?.server_coverage_pct ?? 0;
  const clientPct = current?.client_coverage?.client_computed_pct ?? null;
  const mismatch = clientPct != null && Math.abs(clientPct - serverPct) > 5;
  const inQueue = ['available', 'accepted', 'in_progress', 'submitted'].includes(job.status);

  const answers = current?.checklist?.answers ?? {};
  const fieldsById = new Map(template?.fields.map((f) => [f.id, f]) ?? []);
  const sections = template?.sections ?? [];

  /**
   * Photographs filed under the section whose question they answer.
   *
   * CFPI records `checklist_field_id` on every capture, and the template says
   * which section that field belongs to — so a photo taken against "overall
   * structural condition" can be shown with it instead of in a gallery the
   * reviewer has to correlate by eye.
   */
  const photosBySection = new Map<string, typeof current.attachments>();
  const looseShots: typeof current.attachments = [];
  for (const a of current?.attachments ?? []) {
    const sectionId = a.checklist_field_id
      ? fieldsById.get(a.checklist_field_id)?.section_id
      : undefined;
    if (sectionId) {
      photosBySection.set(sectionId, [...(photosBySection.get(sectionId) ?? []), a]);
    } else {
      looseShots.push(a);
    }
  }

  return (
    <div className="page detailpage">
      {/* A button, not a link in body text. Leaving a record is the second
          most common thing done on this page and it was a line of small blue
          text competing with a 32px drain name directly beneath it. */}
      <Link to="/" className="crumb">
        <span aria-hidden="true">←</span> Back to dashboard
      </Link>

      <div className="detail-head">
        <div>
          <h2>{job.asset.name}</h2>
          <div className="facts">
            {job.asset.length_m.toFixed(0)} m · {job.asset.type.replace(/_/g, ' ')} ·{' '}
            <span className={`due-${inQueue ? dueLabel(job.due_at).severity : 'later'}`}>
              {dueLabel(job.due_at).text}
            </span>{' '}
            ({new Date(job.due_at).toLocaleDateString()})
          </div>
        </div>
        <div className="headactions">
          <span className="pill" style={{ background: jobStatusColour(job) }}>
            {jobStatusLabel(job)}
          </span>
          {job.status === 'submitted' && current && (
            <>
              <button className="btn primary" disabled={busy} onClick={() => review('approved')}>
                Approve
              </button>
              <button className="btn danger" disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </button>
            </>
          )}
          {inQueue ? (
            <button className="btn" disabled={busy} onClick={() => queueAction(() => api.close(job.id))}>
              Remove from queue
            </button>
          ) : (
            <button
              className="btn dark"
              disabled={busy}
              onClick={() => queueAction(() => api.dispatch(job.id, { due_in_days: 7 }))}
            >
              Add to queue
            </button>
          )}
        </div>
      </div>

      {job.rejection_reason && (
        <div className="mismatch" style={{ marginBottom: 14 }}>
          Sent back to the inspector — “{job.rejection_reason}”
        </div>
      )}

      <div className="split detailsplit">
        {/*
          * Two columns that end level, each scrolling inside itself.
          *
          * Everything except the map used to be stacked in the right-hand
          * column, so a completed inspection ran for several screens beside a
          * map with nothing under it. Split by what the reader is doing: the
          * left is the drain — where it is, what it is, what to know before
          * going — and stays put. The right is this inspection, and is the
          * thing being read.
          */}
        <div className="col">
        <div className="panel">
          <header>
            <h2>Coverage</h2>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {current ? `${current.track_points} GPS points` : 'no inspection yet'}
            </span>
          </header>
          <div className="maprow">
            <DrainMap layers={layers} pins={pins} fitTo={job.asset.geometry.coordinates} />
          </div>
          <div className="legend">
            <span><i style={{ background: '#16a34a' }} />Covered</span>
            <span><i style={{ background: '#dc2626' }} />Not covered</span>
            <span><i style={{ background: '#2563eb' }} />Inspector's GPS track</span>
            <span><i style={{ background: '#f59e0b', height: 10, width: 10, borderRadius: '50%' }} />Photograph</span>
          </div>
        </div>

{/* ------------------------------------------------------- asset */}
          <div className="panel">
            <header><h2>Asset</h2></header>
            <div className="body">
              <dl className="kv">
                <dt>Asset ID</dt><dd>{job.asset.id}</dd>
                <dt>Type</dt><dd style={{ textTransform: 'capitalize' }}>{job.asset.type.replace(/_/g, ' ')}</dd>
                <dt>Length</dt><dd>{job.asset.length_m.toFixed(1)} m</dd>
              </dl>
            </div>
          </div>

          {/* Access notes and hazards live here rather than in the read-only
              asset card: they are the only part of a drain's record a
              supervisor is expected to change, and they reach the handset. */}
          <SiteNotes job={job} onSaved={load} />

          {/* Only when the drain has genuinely been inspected more than once.
              This used to appear for a single inspection because superseded
              attempts were counted — which read as duplicated history for work
              that had only been done once. */}
          {attempts.length > 1 && (
            <div className="panel">
              <header><h2>Previous inspections</h2></header>
              <div className="body" style={{ display: 'grid', gap: 6 }}>
                {attempts.map((i, n) => (
                  <button
                    key={i.id}
                    className={`answer histrow${i.id === current?.id ? ' active' : ''}`}
                    onClick={() => setSelected(i.id)}
                  >
                    <span className="q">
                      Attempt {attempts.length - n} · {new Date(i.started_at).toLocaleDateString()}
                    </span>
                    <span className="a">
                      {(i.server_coverage_pct ?? 0).toFixed(0)}% · {i.status}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="col">
{/* ------------------------------------------------------ result */}
          <div className="panel">
            <header>
              <h2>Result</h2>
              {attempts.length > 1 && (
                <select
                  className="select"
                  value={current?.id ?? ''}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {attempts.map((a, n) => (
                    <option key={a.id} value={a.id}>
                      Attempt {attempts.length - n} · {new Date(a.started_at).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              )}
            </header>
            <div className="body" style={{ display: 'grid', gap: 12 }}>
              {!current && (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                  {job.heartbeat
                    ? `Under way on the inspector's device — ${job.heartbeat.coverage_pct.toFixed(0)}% walked, ${job.heartbeat.status}. Full detail arrives on submission.`
                    : 'No inspection has been started for this job.'}
                </div>
              )}

              {current && (
                <>
                  <div className="cov">
                    <div className={`covpct ${serverPct >= gate ? 'ok' : 'bad'}`}>
                      {serverPct.toFixed(0)}<small>%</small>
                    </div>
                    <div className="covmeta">
                      <div className="covbar">
                        <i style={{ width: `${Math.min(serverPct, 100)}%` }}
                           className={serverPct >= gate ? 'ok' : ''} />
                        <b style={{ left: `${gate}%` }} />
                      </div>
                      <div className="covnote">
                        covered · {gate}% required
                        {clientPct != null && ` · app reported ${clientPct.toFixed(0)}%`}
                      </div>
                    </div>
                  </div>

                  {/* An inspector who could not finish, and said why. The
                      reason matters more than the percentage here. */}
                  {current.override && (
                    <div className="override">
                      <div className="overridetitle">
                        Submitted below threshold —{' '}
                        {current.override.reason_code.replace(/_/g, ' ')}
                      </div>
                      {current.override.notes && (
                        <div className="overridenote">“{current.override.notes}”</div>
                      )}
                    </div>
                  )}

                  {/* Coverage is recomputed here from the raw points. A client
                      claiming materially more than the track supports is the
                      case this exists to catch. */}
                  {mismatch && (
                    <div className="mismatch">
                      Coverage mismatch — the app reported {clientPct!.toFixed(1)}% but the raw
                      GPS track supports only {serverPct.toFixed(1)}%.
                    </div>
                  )}

                  {current.flags.length > 0 && (
                    <div className="flags">
                      {current.flags.map((f) => (
                        <span key={f} className="flag">{f.replace(/_/g, ' ')}</span>
                      ))}
                    </div>
                  )}

                  {current.uncovered_ranges.length > 0 && (
                    <div>
                      <div className="minilabel">Stretches not walked</div>
                      <div className="gaps">
                        {current.uncovered_ranges.map(([a, b], i) => (
                          <span key={i} className="gap">{a.toFixed(0)}–{b.toFixed(0)} m</span>
                        ))}
                      </div>
                    </div>
                  )}

                  <dl className="kv">
                    {current.inspector_name && (
                      <>
                        <dt>Inspector</dt>
                        <dd>{current.inspector_name}</dd>
                      </>
                    )}
                    <dt>Started</dt>
                    <dd>{new Date(current.started_at).toLocaleString()}</dd>
                    {current.ended_at && (
                      <>
                        <dt>Submitted</dt>
                        <dd>{new Date(current.ended_at).toLocaleString()}</dd>
                        <dt>On site</dt>
                        <dd>
                          {Math.max(
                            1,
                            Math.round(
                              (Date.parse(current.ended_at) - Date.parse(current.started_at)) / 60000,
                            ),
                          )} min
                        </dd>
                      </>
                    )}
                    {current.supersedes_inspection_id && (
                      <>
                        <dt>Re-inspection of</dt>
                        <dd>{current.supersedes_inspection_id.slice(0, 8)}…</dd>
                      </>
                    )}
                  </dl>

                  {current.review && (
                    <div className="note">
                      {current.review.decision === 'approved' ? 'Approved' : 'Sent back'} on{' '}
                      {new Date(current.review.at).toLocaleString()}
                      {current.review.reason && ` — “${current.review.reason}”`}
                    </div>
                  )}
                </>
              )}
            </div>

          {/* What the model made of it, and what the inspector recorded, both
              read as part of the result rather than as separate cards
              competing with it. */}
          {current && current.status !== 'in_progress' && (
            <AutoReview
              inspectionId={current.id}
              review={current.ai_review}
              onRefreshed={load}
            />
          )}

          {current?.checklist && (
            <div className="subsection">
              <div className="subhead">
                <h3>Checklist</h3>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {current.checklist.template_id} v{current.checklist.template_version}
                </span>
              </div>
              <div className="body">
                {(sections.length ? sections : [{ id: '_', title: '' }]).map((sec) => {
                  const entries = Object.entries(answers).filter(([k]) =>
                    sections.length ? fieldsById.get(k)?.section_id === sec.id : true,
                  );
                  const shots = photosBySection.get(sec.id) ?? [];
                  if (entries.length === 0 && shots.length === 0) return null;
                  return (
                    <div key={sec.id} className="sec">
                      {sec.title && <div className="minilabel">{sec.title}</div>}
                      <div className="answers">
                        {entries.map(([k, v]) => {
                          const f = fieldsById.get(k);
                          return (
                            <div key={k} className={`answer${isConcerning(k, v) ? ' concern' : ''}`}>
                              <span className="q">{f?.label ?? titleCase(k)}</span>
                              <span className="a">{formatAnswer(v, f)}</span>
                            </div>
                          );
                        })}
                      </div>

                      {/* The photographs taken against this section's questions,
                          shown with them. A reviewer reading "structural
                          condition: poor" wants the picture of it there, not in
                          a separate gallery they have to correlate by hand. */}
                      {shots.length > 0 && (
                        <div className="photos secphotos">
                          {shots.map((a) => (
                            <button
                              key={a.id}
                              className={`photo${a.stored ? '' : ' missing'}`}
                              onClick={() => a.stored && setLightbox(`/uploads/${a.id}.jpg`)}
                              title={a.caption ?? fieldsById.get(a.checklist_field_id ?? '')?.label ?? ''}
                            >
                              {a.stored ? <img src={`/uploads/${a.id}.jpg`} alt="" /> : 'Not uploaded'}
                              {a.source === 'library' && <i className="fromalbum">album</i>}
                              {a.chainage_m != null && <span>{a.chainage_m.toFixed(0)} m</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* Answers whose field is not in the template — an older
                    submission against a schema that has since changed. */}
                {sections.length > 0 &&
                  Object.keys(answers).some((k) => !fieldsById.has(k)) && (
                    <div className="sec">
                      <div className="minilabel">Other</div>
                      <div className="answers">
                        {Object.entries(answers)
                          .filter(([k]) => !fieldsById.has(k))
                          .map(([k, v]) => (
                            <div key={k} className="answer">
                              <span className="q">{titleCase(k)}</span>
                              <span className="a">{formatAnswer(v)}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
              </div>
            </div>
          )}

          </div>

          {/* ------------------------------------------------------ photos */}
          {/* Only what could not be filed against a question — general
              condition shots and override evidence. Everything else appears
              inside the checklist, next to the answer it supports. */}
          {current && looseShots.length > 0 && (
            <div className="panel">
              <header><h2>Other photographs ({looseShots.length})</h2></header>
              <div className="body">
                <div className="photos">
                  {looseShots.map((a) => (
                    <button
                      key={a.id}
                      className={`photo${a.stored ? '' : ' missing'}`}
                      onClick={() => a.stored && setLightbox(`/uploads/${a.id}.jpg`)}
                      title={a.caption ?? ''}
                    >
                      {a.stored ? <img src={`/uploads/${a.id}.jpg`} alt={a.caption ?? ''} /> : 'Not uploaded'}
                      {/* Chosen from the album rather than taken on site — the
                          reviewer should weigh it differently, so say so. */}
                      {a.source === 'library' && <i className="fromalbum">album</i>}
                      {a.chainage_m != null && <span>{a.chainage_m.toFixed(0)} m</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* -------------------------------------------------- work orders */}
          <div className="panel">
            <header>
              <h2>Follow-ups</h2>
              {current && (
                <button
                  className="btn tiny primary"
                  disabled={busy}
                  onClick={() => setRouting(true)}
                >
                  Route to officer
                </button>
              )}
            </header>
            <div className="body">
              {orders.length === 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {suggestion
                    ? 'Nothing routed yet — this inspection has findings worth acting on.'
                    : 'Nothing routed for this drain.'}
                </div>
              )}
              <div style={{ display: 'grid', gap: 8 }}>
                {orders.map((w) => (
                  <div key={w.id} className="answer">
                    <span className="q">
                      {w.detail || w.title}
                      {w.assigned_to && (
                        <>
                          <br />
                          <small style={{ color: 'var(--muted)' }}>→ {w.assigned_to}</small>
                        </>
                      )}
                    </span>
                    <span className="a">
                      {w.due_at ? dueLabel(w.due_at).text : 'no due date'}
                      <br />
                      <small style={{ color: 'var(--muted)' }}>
                        {w.status.replace(/_/g, ' ')}
                      </small>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {routing && (
        <RouteFollowUp
          jobId={job.id}
          suggestion={suggestion}
          busy={busy}
          onCancel={() => setRouting(false)}
          onSubmit={routeFollowUp}
        />
      )}

      {rejecting && current && (
        <RejectInspection
          coveragePct={serverPct}
          gapCount={current.uncovered_ranges.length}
          busy={busy}
          onCancel={() => setRejecting(false)}
          onSubmit={(d) => review('rejected', d.reason)}
        />
      )}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}
