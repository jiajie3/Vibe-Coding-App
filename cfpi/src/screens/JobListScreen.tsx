import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { actionableJobs, getJobs, isUsingBundledData, syncJobs } from '../data/jobs.ts';
import { DUE_COLOUR, dueLabel } from '../core/due.ts';
import type { Job } from '../core/types.ts';
import { listInspections } from '../services/persistence.ts';
import { isDemoMode } from '../services/auth.ts';
import { isConfigured } from '../services/config.ts';
import { drain, onOutboxChange, stats } from '../services/outbox.ts';

const STATUS_LABEL: Record<string, string> = {
  available: 'Due for inspection',
  accepted: 'Accepted',
  in_progress: 'In progress',
};

function JobRow({
  job,
  progress,
  onPress,
}: {
  job: Job;
  progress?: number;
  onPress: () => void;
}) {
  const due = dueLabel(job.due_at);
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
    >
      {/* Deadline, not priority. The bar used to show a `priority` field stamped
          when the job was queued and never recalculated, so it could sit calm
          and blue while the due date beside it read "Overdue by 2d". */}
      <View style={[styles.dueBar, { backgroundColor: DUE_COLOUR[due.severity] }]} />
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text style={styles.reference}>{job.reference}</Text>
          <Text style={[styles.due, styles[`due_${due.severity}`]]}>{due.text}</Text>
        </View>

        <Text style={styles.name} numberOfLines={2}>
          {job.asset.name}
        </Text>

        {/* A job sent back by a reviewer looks identical to a new one unless we
            say so. Without the reason the inspector repeats the same walk and
            gets rejected again. */}
        {job.rejection_reason && (
          <View style={styles.rejected}>
            <Text style={styles.rejectedTitle}>Sent back for re-inspection</Text>
            <Text style={styles.rejectedText}>{job.rejection_reason}</Text>
          </View>
        )}

        {/* A part-walked inspection is only resumable if the inspector can find
            it again. Without this the saved coverage is invisible. */}
        {progress != null && (
          <View style={styles.resumeRow}>
            <View style={styles.resumeTrack}>
              <View style={[styles.resumeFill, { width: `${Math.min(progress, 100)}%` }]} />
            </View>
            <Text style={styles.resumeText}>{progress.toFixed(0)}% · tap to resume</Text>
          </View>
        )}

        <View style={styles.metaRow}>
          <Text style={styles.meta}>{job.asset.length_m.toFixed(0)} m</Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.meta}>{job.asset.type.replace(/_/g, ' ')}</Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.meta}>
            {job.rejection_reason ? 'To re-inspect' : (STATUS_LABEL[job.status] ?? job.status)}
          </Text>
        </View>

        {job.asset.hazards && job.asset.hazards.length > 0 && (
          <View style={styles.hazardRow}>
            {job.asset.hazards.map((h) => (
              <View key={h} style={styles.hazard}>
                <Text style={styles.hazardText}>{h.replace(/_/g, ' ')}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </Pressable>
  );
}

export default function JobListScreen({ navigation }: { navigation: any }) {
  const [tick, setTick] = useState(0);
  const allJobs = useMemo(() => actionableJobs(), [tick]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [queue, setQueue] = useState(stats());

  useEffect(() => onOutboxChange(() => setQueue(stats())), []);

  // Re-read on focus rather than on mount: the inspector returns here after
  // pausing, and a stale list would not show the progress they just saved.
  useFocusEffect(
    useCallback(() => {
      const map: Record<string, number> = {};
      for (const rec of listInspections()) map[rec.job_id] = rec.coverage_pct;
      setProgress(map);

      // Opportunistic sync: pull the latest jobs and push anything queued.
      // Failure is silent — being out of range is the normal state, not an error.
      // Demo mode has no server behind it, so there is nothing to reach for.
      if (isConfigured() && !isDemoMode()) {
        void syncJobs().then((r) => r.ok && setTick((t) => t + 1));
        void drain();
      }
    }, []),
  );

  // In-progress jobs float to the top — that is what the inspector came back for.
  const jobs = useMemo(
    () =>
      [...allJobs].sort(
        (a, b) => (progress[b.id] != null ? 1 : 0) - (progress[a.id] != null ? 1 : 0),
      ),
    [allJobs, progress],
  );

  const totalKm = useMemo(
    () => jobs.reduce((s, j) => s + j.asset.length_m, 0) / 1000,
    [jobs],
  );
  const resumable = Object.keys(progress).length;

  // A job the server sent but the list is not showing has been submitted from
  // this device and is waiting to sync. Saying so turns "where did my job go?"
  // into a fact — the failure mode that cost us an afternoon.
  const hidden = getJobs().length - jobs.length;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Inspections</Text>
            <Text style={styles.brandline}>Coastal &amp; Flood Protection Inspection</Text>
          </View>
          <Pressable
            style={styles.gear}
            hitSlop={12}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={styles.gearText}>⚙</Text>
            {queue.pending + queue.dead > 0 && (
              <View style={[styles.badge, queue.dead > 0 && styles.badgeBad]}>
                <Text style={styles.badgeText}>{queue.pending + queue.dead}</Text>
              </View>
            )}
          </Pressable>
        </View>
        <Text style={styles.subtitle}>
          {jobs.length} jobs · {totalKm.toFixed(1)} km of drain
          {resumable > 0 && ` · ${resumable} in progress`}
          {hidden > 0 && ` · ${hidden} submitted, awaiting sync`}
        </Text>

        {/* Being offline is normal and not worth flagging. Never having
            connected at all means the inspector is looking at demo data. */}
        {isDemoMode() && (
          <View style={styles.demoBanner}>
            <Text style={styles.demoText}>
              Demo mode — bundled Singapore drains, nothing is sent anywhere. Sign out
              to connect to FRCDE.
            </Text>
          </View>
        )}
        {!isDemoMode() && !isConfigured() && (
          <Pressable
            style={styles.setupBanner}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={styles.setupText}>
              Not connected to FRCDE — showing demo data. Tap to set the server address.
            </Text>
          </Pressable>
        )}
        {!isDemoMode() && isConfigured() && isUsingBundledData() && (
          <Pressable
            style={styles.setupBanner}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={styles.setupText}>
              No jobs downloaded yet — tap to sync with FRCDE.
            </Text>
          </Pressable>
        )}
      </View>

      <FlatList
        data={jobs}
        keyExtractor={(j) => j.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <JobRow
            job={item}
            progress={progress[item.id]}
            onPress={() => navigation.navigate('Inspection', { jobId: item.id })}
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F1F5F9' },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gear: { padding: 4 },
  gearText: { fontSize: 24, color: '#475569' },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeBad: { backgroundColor: '#DC2626' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  setupBanner: {
    marginTop: 12,
    backgroundColor: '#DBEAFE',
    borderRadius: 10,
    padding: 11,
  },
  setupText: { fontSize: 12.5, color: '#1D4ED8', fontWeight: '600' },
  demoBanner: { marginTop: 12, backgroundColor: '#FEF3C7', borderRadius: 10, padding: 11 },
  demoText: { fontSize: 12.5, color: '#92400E', fontWeight: '600' },
  title: { fontSize: 30, fontWeight: '700', color: '#0F172A', letterSpacing: -0.5 },
  brandline: { fontSize: 11, color: '#94A3B8', fontWeight: '700', marginTop: -2 },
  subtitle: { fontSize: 14, color: '#64748B', marginTop: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },

  card: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardPressed: { opacity: 0.7 },
  dueBar: { width: 5 },
  cardBody: { flex: 1, padding: 14 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reference: { fontSize: 12, fontWeight: '600', color: '#94A3B8', letterSpacing: 0.4 },
  due: { fontSize: 12, fontWeight: '700' },
  // Same three states as the console: red is late, amber is due soon, grey informs.
  due_overdue: { color: '#DC2626' },
  due_soon: { color: '#B45309' },
  due_later: { color: '#64748B', fontWeight: '600' },
  name: { fontSize: 17, fontWeight: '600', color: '#0F172A', marginTop: 6 },

  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 },
  meta: { fontSize: 13, color: '#475569', textTransform: 'capitalize' },
  dot: { color: '#CBD5E1' },

  rejected: {
    marginTop: 10,
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    padding: 9,
    gap: 2,
  },
  rejectedTitle: { fontSize: 11, fontWeight: '800', color: '#B91C1C', textTransform: 'uppercase' },
  rejectedText: { fontSize: 12.5, color: '#991B1B' },

  resumeRow: { marginTop: 10, gap: 4 },
  resumeTrack: { height: 5, borderRadius: 3, backgroundColor: '#E2E8F0', overflow: 'hidden' },
  resumeFill: { height: '100%', backgroundColor: '#16A34A' },
  resumeText: { fontSize: 11, color: '#15803D', fontWeight: '700' },

  hazardRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  hazard: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  hazardText: { fontSize: 11, color: '#92400E', fontWeight: '600', textTransform: 'capitalize' },
});
