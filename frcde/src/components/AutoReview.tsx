import { useState } from 'react';

import { api } from '../api.ts';
import type { AiReview } from '../api.ts';
import { toast } from '../toast.ts';

/**
 * A second opinion, when a supervisor asks for one.
 *
 * It does not run on submission any more. Reviewing everything automatically
 * spent money on inspections nobody had opened, and put a verdict in front of a
 * reviewer before they had formed their own — the wrong order for something
 * that is only ever advice.
 *
 * The output is a recommendation and a reason, in prose. It used to arrive as a
 * taxonomy — checks, then photograph notes, each tagged by where it came from —
 * and a reader had to assemble the meaning out of four lists. What is wanted is
 * what a colleague would say: here is what I would do, and here is why.
 *
 * There is still no button here that approves or rejects anything. The
 * supervisor's own controls stay in the page header.
 */

const VERDICT: Record<AiReview['verdict'], { label: string; tone: string }> = {
  looks_sound: { label: 'Looks approvable', tone: 'ok' },
  needs_a_look: { label: 'Worth a look', tone: 'warn' },
  likely_reject: { label: 'Would send back', tone: 'bad' },
  skipped: { label: 'Not checked', tone: 'muted' },
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

  const run = async () => {
    setBusy(true);
    try {
      await api.rerunAiReview(inspectionId);
      onRefreshed();
    } catch (e) {
      toast.error(e, 'Could not run the check');
    } finally {
      setBusy(false);
    }
  };

  const v = review ? VERDICT[review.verdict] : null;

  return (
    <div className={`subsection ai${busy ? ' thinking' : ''}`}>
      <div className="subhead">
        <h3>Let AI check for you</h3>
        <button className="btn tiny" onClick={run} disabled={busy}>
          {busy ? 'Reading…' : review ? 'Check again' : 'Run the check'}
        </button>
      </div>

      <div className="body">
        {busy ? (
          <p className="aiwait">Reading the coverage, the answers and the photographs…</p>
        ) : review ? (
          <>
            {v && <span className={`verdict ${v.tone}`}>{v.label}</span>}
            <p className="aitext">{review.explanation}</p>
            {/* Which model, under which instructions. Without it a verdict from
                six months ago cannot be explained or reproduced. */}
            {review.verdict !== 'skipped' && (
              <p className="provenance">
                {review.model} · prompt v{review.prompt_version} ·{' '}
                {new Date(review.generated_at).toLocaleString()}
              </p>
            )}
          </>
        ) : (
          <p className="aiwait">
            Nothing checked yet. Run it for a second opinion on the coverage, the
            answers and the photographs.
          </p>
        )}
      </div>
    </div>
  );
}
