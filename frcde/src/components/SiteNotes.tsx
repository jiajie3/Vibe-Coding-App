import { useEffect, useState } from 'react';

import { api } from '../api.ts';
import type { JobRecord } from '../api.ts';
import { toast } from '../toast.ts';

/**
 * Editor for the two fields that exist purely for the person at the gate.
 *
 * Kept separate from the read-only asset facts because these are the only part
 * of a drain's record a supervisor is expected to change, and it should be
 * obvious which parts those are.
 */

/** Common hazards, offered as one-tap additions. Free text still works. */
const SUGGESTED = [
  'confined_space',
  'deep_water',
  'steep_batter',
  'vehicular_traffic',
  'slippery_surface',
  'vegetation_overgrowth',
  'wildlife',
  'restricted_access',
  'unstable_ground',
  'night_work_only',
];

const pretty = (h: string) => h.replace(/_/g, ' ');
const normalise = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');

export default function SiteNotes({
  job,
  onSaved,
}: {
  job: JobRecord;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState(job.asset.access_notes ?? '');
  const [hazards, setHazards] = useState<string[]>(job.asset.hazards ?? []);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Re-seed when the server sends a newer version of the job, but not while the
  // user is mid-edit — the 5 s poll would otherwise wipe what they are typing.
  useEffect(() => {
    if (saving) return;
    setNotes(job.asset.access_notes ?? '');
    setHazards(job.asset.hazards ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.version]);

  const dirty =
    notes !== (job.asset.access_notes ?? '') ||
    hazards.join('|') !== (job.asset.hazards ?? []).join('|');

  const addHazard = (raw: string) => {
    const h = normalise(raw);
    if (!h || hazards.includes(h)) return;
    setHazards([...hazards, h]);
    setDraft('');
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.updateAsset(job.id, { access_notes: notes, hazards });
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      toast.error(e, 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const unused = SUGGESTED.filter((h) => !hazards.includes(h));

  return (
    <div className="panel">
      <header>
        <h2>Site notes</h2>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>shown to the inspector</span>
      </header>
      <div className="body" style={{ display: 'grid', gap: 14 }}>
        <div>
          <div className="minilabel">Access</div>
          <textarea
            className="textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Gate at the Clementi Road end — key from the depot before 08:00. No vehicle access past the barrier."
            rows={3}
          />
        </div>

        <div>
          <div className="minilabel">Hazards</div>
          <div className="tags">
            {hazards.map((h) => (
              <span key={h} className="tag">
                {pretty(h)}
                <button
                  aria-label={`Remove ${pretty(h)}`}
                  onClick={() => setHazards(hazards.filter((x) => x !== h))}
                >
                  ×
                </button>
              </span>
            ))}
            {hazards.length === 0 && <span className="tagempty">None recorded</span>}
          </div>

          <input
            className="input"
            value={draft}
            placeholder="Add a hazard and press Enter"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addHazard(draft);
              }
            }}
          />

          {unused.length > 0 && (
            <div className="suggest">
              {unused.slice(0, 6).map((h) => (
                <button key={h} onClick={() => addHazard(h)}>+ {pretty(h)}</button>
              ))}
            </div>
          )}
        </div>

        <div className="btnrow" style={{ alignItems: 'center' }}>
          <button className="btn dark" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save site notes'}
          </button>
          {saved && (
            <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 700 }}>
              ✓ Saved — reaches the app at its next sync
            </span>
          )}
          {dirty && !saving && !saved && (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Unsaved changes</span>
          )}
        </div>
      </div>
    </div>
  );
}
