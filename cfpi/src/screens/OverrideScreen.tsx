import { useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { multilineDoneProps } from '../components/KeyboardDone.tsx';
import { setAnswer, useSession } from '../state/session.ts';
import { getJob } from '../data/jobs.ts';

/**
 * Submitting below the coverage threshold, with a recorded reason.
 *
 * Field work is made of exceptions — locked gates, flooding, a contractor's
 * compound across the alignment. Without a way to record one, an inspector has
 * two options: walk the drain badly to game the percentage, or leave the job
 * open forever. Both are worse than an honest 62% with "access blocked at
 * chainage 210" and a photograph of the gate.
 *
 * This is an exception on the record, not a way around the rule. It demands a
 * reason, and evidence when the job asks for it, and it flags the inspection for
 * review either way.
 */

const REASONS: {
  code: string;
  label: string;
  hint: string;
  /** The matching `access_reason` option, so the checklist need not ask again. */
  access: string;
}[] = [
  {
    code: 'access_blocked',
    label: 'Access blocked',
    hint: 'Locked gate, fencing, private land',
    access: 'locked',
  },
  {
    code: 'flooded',
    label: 'Flooded',
    hint: 'Water level too high to walk safely',
    access: 'water',
  },
  {
    code: 'unsafe_conditions',
    label: 'Unsafe conditions',
    hint: 'Weather, traffic, structural risk',
    access: 'unsafe',
  },
  {
    code: 'obstruction',
    label: 'Obstruction on site',
    hint: 'Works, vehicles, vegetation',
    access: 'works',
  },
  {
    // Nothing on site stopped the walk, so no access category fits. "Other"
    // with the note is the honest answer rather than the nearest-looking one.
    code: 'equipment_failure',
    label: 'Equipment failure',
    hint: 'Phone, torch or PPE fault',
    access: 'other',
  },
  { code: 'other', label: 'Other', hint: 'Describe it below', access: 'other' },
];

export default function OverrideScreen({ navigation }: { navigation: any }) {
  const session = useSession();
  const job = getJob(session.job?.id ?? '')!;
  const rules = job.inspection_rules;

  const [reason, setReason] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const coverage = session.coverage?.client_computed_pct ?? 0;
  const gaps = session.coverage?.uncovered_ranges_m ?? [];

  // Photos taken specifically as override evidence, plus anything already
  // attached — a photo of the locked gate may well have been taken already.
  const photos = session.photos;
  const needsPhoto = rules.require_photo_on_override;

  const submit = () => {
    if (!reason) return setError('Choose a reason.');
    if (reason === 'other' && notes.trim().length < 5) {
      return setError('Describe what stopped you.');
    }
    if (needsPhoto && photos.length === 0) {
      return setError('Take a photograph showing why the stretch could not be walked.');
    }
    /**
     * Record the same fact on the checklist.
     *
     * Saying "I could not walk the full stretch" and then leaving "was the full
     * stretch accessible?" blank — or worse, answered Yes — puts two
     * contradictory statements in one submission. The override *is* the answer,
     * so it fills the question in, and supplies the follow-up the template then
     * requires so the inspector is not asked to type the reason twice.
     *
     * Field ids that a template does not contain are stripped by `prune()`
     * before submission, so this is safe against a different checklist.
     */
    setAnswer('site_accessible', false);
    const chosen = REASONS.find((r) => r.code === reason);
    setAnswer('access_reason', chosen?.access ?? 'other');
    // Only the box that "Other" opens, and only when it is open. Filling a
    // field the checklist will not show just leaves an orphan for prune() to
    // strip on the way out.
    if ((chosen?.access ?? 'other') === 'other') {
      setAnswer(
        'access_other',
        notes.trim() || `${chosen?.label ?? reason}. ${chosen?.hint ?? ''}`.trim(),
      );
    }

    navigation.navigate('Checklist', {
      override: {
        reason_code: reason,
        notes: notes.trim() || undefined,
        photo_ids: photos.map((p) => p.id),
      },
    });
  };

  if (!rules.allow_override) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <View style={styles.body}>
          <Text style={styles.title}>Not permitted</Text>
          <Text style={styles.help}>
            This job does not allow submitting below {rules.min_coverage_pct}% coverage.
            Contact your supervisor.
          </Text>
          <Pressable style={styles.cancel} onPress={() => navigation.goBack()}>
            <Text style={styles.cancelText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* The same pill as All jobs and Map. Three ways back that look like
            three different controls is three things to learn. */}
        <Pressable onPress={() => navigation.goBack()} hitSlop={12} style={styles.backRow}>
          <Text style={styles.backChevron}>‹</Text>
          <Text style={styles.back}>Map</Text>
        </Pressable>

        <Text style={styles.title}>Submit without full coverage</Text>
        <Text style={styles.help}>
          You walked {coverage.toFixed(0)}% of {job.asset.name}. Tell us what stopped
          you.
        </Text>

        {gaps.length > 0 && (
          <View style={styles.gapBox}>
            <Text style={styles.gapTitle}>Not walked</Text>
            <View style={styles.gapRow}>
              {gaps.map(([a, b], i) => (
                <Text key={i} style={styles.gapChip}>
                  {a.toFixed(0)}–{b.toFixed(0)} m
                </Text>
              ))}
            </View>
          </View>
        )}

        <Text style={styles.section}>Reason</Text>
        <View style={{ gap: 8 }}>
          {REASONS.map((r) => {
            const active = reason === r.code;
            return (
              <Pressable
                key={r.code}
                style={[styles.reason, active && styles.reasonActive]}
                onPress={() => {
                  setReason(r.code);
                  setError(null);
                }}
              >
                <View style={[styles.radio, active && styles.radioActive]} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.reasonLabel, active && styles.reasonLabelActive]}>
                    {r.label}
                  </Text>
                  <Text style={styles.reasonHint}>{r.hint}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>Notes {reason === 'other' && <Text style={styles.req}>*</Text>}</Text>
        <TextInput
          style={styles.input}
          multiline
          value={notes}
          onChangeText={setNotes}
          {...multilineDoneProps}
        />

        <Text style={styles.section}>
          Evidence {needsPhoto && <Text style={styles.req}>*</Text>}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.photoRow}>
            {photos.map((p) => (
              <Image key={p.id} source={{ uri: p.uri }} style={styles.thumb} />
            ))}
            <Pressable
              style={styles.addPhoto}
              onPress={() => navigation.navigate('Camera', { fieldId: null })}
            >
              <Text style={styles.addPhotoPlus}>＋</Text>
              <Text style={styles.addPhotoText}>Photo</Text>
            </Pressable>
          </View>
        </ScrollView>

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={styles.submit} onPress={submit}>
          <Text style={styles.submitText}>Continue to checklist</Text>
        </Pressable>
        <Pressable style={styles.cancel} onPress={() => navigation.goBack()}>
          <Text style={styles.cancelText}>Cancel — keep walking</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F1F5F9' },
  body: { padding: 20, paddingBottom: 40, gap: 10 },
  backRow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 8,
    paddingLeft: 10,
    paddingRight: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  backChevron: { fontSize: 19, color: '#2563EB', fontWeight: '800', marginTop: -2 },
  back: { fontSize: 15, color: '#2563EB', fontWeight: '700' },
  title: { fontSize: 24, fontWeight: '700', color: '#0F172A', letterSpacing: -0.4 },
  help: { fontSize: 13.5, color: '#475569', lineHeight: 20 },
  section: { fontSize: 12, fontWeight: '800', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 12 },
  req: { color: '#DC2626' },

  gapBox: { backgroundColor: '#FEF2F2', borderRadius: 12, padding: 12, gap: 8, marginTop: 6 },
  gapTitle: { fontSize: 11, fontWeight: '800', color: '#B91C1C', textTransform: 'uppercase' },
  gapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  gapChip: {
    backgroundColor: '#FEE2E2',
    color: '#991B1B',
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },

  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 13,
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  reasonActive: { borderColor: '#2563EB', backgroundColor: '#EFF6FF' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#CBD5E1' },
  radioActive: { borderColor: '#2563EB', borderWidth: 6 },
  reasonLabel: { fontSize: 15, fontWeight: '600', color: '#0F172A' },
  reasonLabelActive: { color: '#1E40AF' },
  reasonHint: { fontSize: 12, color: '#64748B', marginTop: 1 },

  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 12,
    minHeight: 84,
    textAlignVertical: 'top',
    fontSize: 15,
    color: '#0F172A',
  },

  photoRow: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  thumb: { width: 76, height: 76, borderRadius: 10, backgroundColor: '#E2E8F0' },
  addPhoto: {
    width: 76,
    height: 76,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPhotoPlus: { fontSize: 20, color: '#64748B', lineHeight: 24 },
  addPhotoText: { fontSize: 11, color: '#64748B', fontWeight: '600' },

  error: { fontSize: 13, color: '#B91C1C', fontWeight: '600', marginTop: 8 },
  submit: {
    backgroundColor: '#D97706',
    paddingVertical: 17,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cancel: { alignItems: 'center', paddingVertical: 14 },
  cancelText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
});
