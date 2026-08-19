import { useState } from 'react';

import { api } from '../api.ts';
import type { AiReview } from '../api.ts';

/**
 * The automated first pass, shown beside the evidence rather than instead of it.
 *
 * It is styled as a briefing, not a decision. There are no buttons here that
 * approve or reject anything — the supervisor's own controls stay where they
 * were, above. A panel that offered "accept the AI's verdict" would turn a
 * reviewer into a clicker, which is the failure mode worth designing against:
 * the point of a first pass is to aim attention, not to replace it.
 *
 * Rule findings and model findings are labelled differently on purpose. One is
 * arithmetic and cannot be wrong; the other is judgement and occasionally is. A
 * reviewer who cannot tell them apart learns to distrust both.
 */

const VERDICT: Record<AiReview['verdict'], { label: string; tone: string }> = {
  looks_sound: { label: 'Looks sound', tone: 'ok' },
  needs_a_look: { label: 'Worth a look', tone: 'warn' },
  likely_reject: { label: 'Does not support approval', tone: 'bad' },
  skipped: { label: 'Not reviewed', tone: 'muted' },
};

export default function AutoReview({
  inspectionId,
  review,
  onRefreshed,
}: {
  inspectionId: string;
  review: AiReview | null | undefined;
  onRefreshed: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const rerun = async () => {
    setBusy(true);
    try {
      await api.rerunAiReview(inspectionId);
      onRefreshed();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not run the review');
    } finally {
      setBusy(false);
    }
  };

  const v = VERDICT[review?.verdict ?? 'skipped'];
  const rules = review?.concerns.filter((c) => c.source === 'rule') ?? [];
  const model = review?.concerns.filter((c) => c.source === 'model') ?? [];
  const photos = review?.photo_notes ?? [];

  return (
    <div className="panel">
      <header>
        <h2>First pass</h2>
        <button className="btn tiny" onClick={rerun} disabled={busy}>
          {busy ? 'Reading…' : 'Run again'}
        </button>
      </header>

      <div className="autoreview">
        <div className={`verdict ${v.tone}`}>{v.label}</div>

        {review ? (
          <>
            <p className="summary">{review.summary}</p>

            {rules.length > 0 && (
              <>
                <p className="grouphead">Checks</p>
                <ul className="concerns">
                  {rules.map((c, i) => (
                    <li key={`r${i}`}>
                      <span className="tag rule">rule</span>
                      {c.detail}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {model.length > 0 && (
              <>
                <p className="grouphead">Worth checking</p>
                <ul className="concerns">
                  {model.map((c, i) => (
                    <li key={`m${i}`}>
                      <span className="tag model">read</span>
                      {c.detail}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {photos.length > 0 && (
              <>
                <p className="grouphead">Photographs</p>
                <ul className="concerns">
                  {photos.map((p) => (
                    <li key={p.attachment_id}>
                      <span className={`tag ${p.shows_drain ? 'model' : 'bad'}`}>
                        {p.shows_drain ? 'drain' : 'not a drain'}
                      </span>
                      {p.note}
                      {p.matches_description === false && (
                        <strong> Does not match what was described.</strong>
                      )}
                      {p.quality === 'poor' && <em> Poor quality.</em>}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {rules.length === 0 && model.length === 0 && review.verdict !== 'skipped' && (
              <p className="summary muted">Nothing flagged.</p>
            )}

            {/* Which model, and under which instructions. Without it a verdict
                from six months ago cannot be explained or reproduced. */}
            <p className="provenance">
              {review.verdict === 'skipped'
                ? 'Rule checks only.'
                : `${review.model} · prompt v${review.prompt_version} · ${new Date(
                    review.generated_at,
                  ).toLocaleString()}`}
            </p>
          </>
        ) : (
          <p className="summary muted">
            This inspection was submitted before automatic review existed. Run it
            now if it is worth a second opinion.
          </p>
        )}

        <p className="provenance">
          Advisory only — approving or sending back is still your call, above.
        </p>
      </div>
    </div>
  );
}
