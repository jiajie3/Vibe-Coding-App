import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { patchJob } from '../data/jobs.ts';
import { deleteInspection } from '../services/persistence.ts';
import { drain, enqueue, onOutboxChange, stats } from '../services/outbox.ts';
import { resetSession, useSession } from '../state/session.ts';

/**
 * What CFPI would POST to `/v1/inspections/{id}/complete`.
 *
 * Shown in full for the mockup. Once the outbox exists this screen becomes a
 * simple "queued for sync" confirmation — but seeing the assembled payload is
 * the fastest way to confirm both halves of the system agree on the contract.
 */
export default function SubmittedScreen({ navigation, route }: { navigation: any; route: any }) {
  const session = useSession();

  const payload = useMemo(
    () => ({
      ended_at: session.ended_at,
      coverage: session.coverage,
      override: route.params.override ?? null,
      checklist: {
        template_id: route.params.template_id,
        template_version: route.params.template_version,
        answers: route.params.answers,
      },
      attachment_ids: session.photos.map((p) => p.id),
      signature_id: null,
    }),
    [session, route.params],
  );

  const queued = useRef(false);
  const [queue, setQueue] = useState(stats());

  // Enqueue exactly once — this screen re-renders as the outbox drains, and a
  // second submission would create a duplicate inspection server-side.
  useEffect(() => {
    if (queued.current) return;
    queued.current = true;
    if (session.job && session.inspection_id) {
      enqueue('complete', session.job.id, session.inspection_id, payload);

      // Mark it submitted locally, straight away. Without this the job stays in
      // the actionable list and the inspector can walk the same drain again,
      // producing a second inspection for work already sent. The server sets the
      // same status when `complete` lands; this just stops the app lying in the
      // meantime, which may be hours if there is no signal.
      patchJob(session.job.id, { status: 'submitted' });
      void drain();
    }
  }, [session.job, session.inspection_id, payload]);

  useEffect(() => onOutboxChange(() => setQueue(stats())), []);

  const done = () => {
    // The saved record exists so an unfinished inspection can be resumed. This
    // one is finished, so clear it — otherwise the job list would keep offering
    // to resume an inspection that has already been submitted.
    if (session.job) deleteInspection(session.job.id);
    resetSession();
    navigation.reset({ index: 0, routes: [{ name: 'Jobs' }] });
  };

  const cov = session.coverage;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.tick}>
          <Text style={styles.tickMark}>✓</Text>
        </View>

        <Text style={styles.title}>Inspection complete</Text>
        <Text style={styles.sub}>
          {session.job?.reference} · {session.job?.asset.name}
        </Text>

        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{cov?.client_computed_pct ?? 0}%</Text>
            <Text style={styles.statLabel}>coverage</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>
              {cov ? `${cov.covered_segments}/${cov.total_segments}` : '—'}
            </Text>
            <Text style={styles.statLabel}>segments</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{session.photos.length}</Text>
            <Text style={styles.statLabel}>photos</Text>
          </View>
        </View>

        {session.flags.length > 0 && (
          <View style={styles.flagBox}>
            <Text style={styles.flagTitle}>Flagged for review</Text>
            {session.flags.map((f) => (
              <Text key={f} style={styles.flagItem}>• {f.replace(/_/g, ' ')}</Text>
            ))}
          </View>
        )}

        <View style={[styles.syncBox, queue.pending === 0 && styles.syncBoxDone]}>
          <Text style={[styles.syncText, queue.pending === 0 && styles.syncTextDone]}>
            {queue.dead > 0
              ? `${queue.dead} item${queue.dead === 1 ? '' : 's'} failed to sync — check Settings`
              : queue.pending === 0
                ? '✓  Synced to FRCDE'
                : `${queue.pending} item${queue.pending === 1 ? '' : 's'} queued — will send when there's signal`}
          </Text>
        </View>

        {/* What happens next, in the inspector's terms. The raw request body
            used to be printed here to prove the contract while the two halves
            were being built; it has no business on a field screen. */}
        <View style={styles.next}>
          <Text style={styles.nextTitle}>What happens next</Text>
          <Text style={styles.nextItem}>
            A supervisor reviews your inspection and either approves it or sends it
            back with a reason.
          </Text>
          <Text style={styles.nextItem}>
            If it comes back, this drain reappears in your job list with the
            reason shown.
          </Text>
        </View>

        <Pressable style={styles.btn} onPress={done}>
          <Text style={styles.btnText}>Back to jobs</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F1F5F9' },
  body: { padding: 20, paddingBottom: 40, gap: 12, alignItems: 'stretch' },

  tick: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#16A34A',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  tickMark: { color: '#fff', fontSize: 32, fontWeight: '700' },

  title: { fontSize: 26, fontWeight: '700', color: '#0F172A', textAlign: 'center' },
  sub: { fontSize: 14, color: '#64748B', textAlign: 'center' },

  stats: { flexDirection: 'row', gap: 10, marginTop: 8 },
  stat: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '800', color: '#0F172A' },
  statLabel: { fontSize: 11, color: '#64748B', marginTop: 2 },

  flagBox: { backgroundColor: '#FEF3C7', borderRadius: 12, padding: 14, gap: 3 },
  flagTitle: { fontSize: 13, fontWeight: '800', color: '#92400E' },
  flagItem: { fontSize: 13, color: '#92400E', textTransform: 'capitalize' },

  syncBox: { backgroundColor: '#FEF3C7', borderRadius: 10, padding: 12, marginTop: 6 },
  syncBoxDone: { backgroundColor: '#DCFCE7' },
  syncText: { fontSize: 13, fontWeight: '700', color: '#92400E' },
  syncTextDone: { color: '#15803D' },

  next: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 8, marginTop: 6 },
  nextTitle: { fontSize: 13, fontWeight: '800', color: '#334155' },
  nextItem: { fontSize: 13, color: '#475569', lineHeight: 19 },

  btn: {
    backgroundColor: '#0F172A',
    paddingVertical: 17,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
