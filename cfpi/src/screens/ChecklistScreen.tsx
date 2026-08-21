import { useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  prune,
  photoFieldId,
  requiresPhoto,
  validate,
  visibleFields,
} from '../core/checklist.ts';
import type {
  AnswerValue,
  ChecklistField,
  ValidationError,
} from '../core/types.ts';
import KeyboardDone, {
  keyboardDoneProps,
  multilineDoneProps,
} from '../components/KeyboardDone.tsx';
import { getTemplate } from '../data/templates.ts';
import { finaliseForSubmit } from '../state/activeInspection.ts';
import {
  finishSession,
  photoCounts,
  removePhoto,
  setAnswer,
  useSession,
} from '../state/session.ts';

/* ------------------------------------------------------------ field widgets */

function Segmented({
  options,
  value,
  onChange,
  locked = false,
}: {
  options: { value: string; label: string }[];
  value: AnswerValue;
  onChange: (v: string) => void;
  locked?: boolean;
}) {
  return (
    <View style={styles.optionList}>
      {options.map((o) => {
        const active = value === o.value;
        // A locked field shows only the answer that was determined for it —
        // offering the alternative and refusing the tap is worse than not
        // offering it.
        if (locked && !active) return null;
        return (
          <Pressable
            key={o.value}
            style={[styles.option, active && styles.optionActive, locked && styles.optionLocked]}
            onPress={() => !locked && onChange(o.value)}
            disabled={locked}
          >
            <View style={[styles.radio, active && styles.radioActive]} />
            <Text style={[styles.optionText, active && styles.optionTextActive]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Chips({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: AnswerValue;
  onChange: (v: string[]) => void;
}) {
  const selected = Array.isArray(value) ? value : [];
  return (
    <View style={styles.chipWrap}>
      {options.map((o) => {
        const active = selected.includes(o.value);
        return (
          <Pressable
            key={o.value}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() =>
              onChange(
                active ? selected.filter((v) => v !== o.value) : [...selected, o.value],
              )
            }
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Severity({
  min,
  max,
  value,
  onChange,
}: {
  min: number;
  max: number;
  value: AnswerValue;
  onChange: (v: number) => void;
}) {
  const scale = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <View style={styles.severityRow}>
      {scale.map((n) => {
        const active = value === n;
        // Colour ramps with severity so a 5 reads as alarming at a glance.
        const tint = `hsl(${Math.round(90 - ((n - min) / (max - min)) * 90)}, 70%, 45%)`;
        return (
          <Pressable
            key={n}
            style={[
              styles.severityBox,
              active && { backgroundColor: tint, borderColor: tint },
            ]}
            onPress={() => onChange(n)}
          >
            <Text style={[styles.severityText, active && styles.severityTextActive]}>
              {n}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Answers the override determines, which the inspector may then not contradict.
 *
 * Recording "I could not walk the full stretch" and then answering "was the full
 * stretch accessible? Yes" would put two opposite statements in one submission,
 * and a reviewer would have no way to tell which was meant.
 *
 * The reason goes with it. An inspector who has just chosen "flooded" and
 * described it should not meet "what stopped you?" again two screens later —
 * they have answered it, and asking twice invites two different answers.
 */
const LOCKED_BY_OVERRIDE = ['site_accessible', 'access_reason', 'access_other'];

/* ------------------------------------------------------------------- screen */

export default function ChecklistScreen({
  navigation,
  route,
}: {
  navigation: any;
  route: any;
}) {
  const session = useSession();
  const job = session.job!;
  const template = useMemo(
    () => getTemplate(job.checklist_template.id, job.checklist_template.version),
    [job],
  );

  const [errors, setErrors] = useState<ValidationError[]>([]);
  const answers = session.answers;
  const counts = photoCounts();

  const fields = visibleFields(template, answers);

  // The coverage gate lives here, on submit — not on reaching this screen.
  // An inspector fills the checklist as they walk; they simply cannot send it
  // until the drain has actually been covered, *or* they have recorded why it
  // could not be (see OverrideScreen).
  const gate = job.inspection_rules.min_coverage_pct;
  const coveragePct = session.coverage?.client_computed_pct ?? 0;
  const override = route.params?.override ?? null;
  const coverageMet = coveragePct >= gate || override !== null;

  /**
   * Every photograph on the inspection, and the one field they belong to.
   *
   * Answers that demand evidence are satisfied from here rather than from a
   * picture filed against the question itself — a surcharged drain is a
   * condition of the stretch, not of the dropdown that asked about it.
   */
  const generalId = photoFieldId(template);
  const generalPhotos = session.photos.filter((p) => p.field_id === generalId);

  const errorFor = (id: string) => errors.find((e) => e.field_id === id);

  const openCamera = (fieldId: string) =>
    navigation.navigate('Camera', { fieldId });

  const submit = async () => {
    if (!coverageMet) return;

    const found = validate(template, answers, counts);
    setErrors(found);
    if (found.length > 0) return;

    // Stop the walk and queue the remaining GPS points before the `complete`
    // call is queued behind them. Skipping this sends a completion the server
    // validates against a partial track — it recomputes coverage, finds it short
    // of the threshold, and rejects the whole inspection with a 422.
    await finaliseForSubmit();
    finishSession();

    navigation.navigate('Submitted', {
      override,
      // prune() strips answers to fields that are no longer visible, so FRCDE
      // never receives a record that contradicts itself.
      answers: prune(template, answers),
      template_id: template.id,
      template_version: template.version,
    });
  };

  const renderField = (field: ChecklistField) => {
    const value = answers[field.id];
    const err = errorFor(field.id);
    const photos = session.photos.filter((p) => p.field_id === field.id);
    const photoDemanded = requiresPhoto(field, answers);
    const locked = LOCKED_BY_OVERRIDE.includes(field.id) && override !== null;

    return (
      <View key={field.id} style={[styles.field, err && styles.fieldError]}>
        <Text style={styles.label}>
          {field.label}
          {field.required && <Text style={styles.required}> *</Text>}
        </Text>
        {field.help_text && !locked && <Text style={styles.help}>{field.help_text}</Text>}

        {/* Answered by the override, and not open to being answered otherwise:
            an inspector cannot both report that the walk was blocked and that
            the stretch was fully accessible. */}
        {locked && (
          <Text style={styles.lockNote}>
            🔒 Set from your reason for not completing the walk
          </Text>
        )}

        {field.type === 'boolean' && (
          <Segmented
            options={[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
            value={value === true ? 'yes' : value === false ? 'no' : undefined}
            onChange={(v) => setAnswer(field.id, v === 'yes')}
            locked={locked}
          />
        )}

        {field.type === 'single_select' && (
          <Segmented
            options={field.options ?? []}
            value={value}
            onChange={(v) => setAnswer(field.id, v)}
            locked={locked}
          />
        )}

        {field.type === 'multi_select' && (
          <Chips
            options={field.options ?? []}
            value={value}
            onChange={(v) => setAnswer(field.id, v)}
          />
        )}

        {field.type === 'severity' && (
          <Severity
            min={field.min ?? 1}
            max={field.max ?? 5}
            value={value}
            onChange={(v) => setAnswer(field.id, v)}
          />
        )}

        {field.type === 'number' && (
          <View style={styles.numberRow}>
            <TextInput
              style={styles.input}
              keyboardType="numeric"
              value={value == null ? '' : String(value)}
              placeholder="0"
              placeholderTextColor="#94A3B8"
              // A numeric keypad has no return key at all on iOS.
              {...keyboardDoneProps}
              onChangeText={(t) =>
                setAnswer(field.id, t === '' ? null : Number(t.replace(/[^0-9.]/g, '')))
              }
            />
            {field.unit && <Text style={styles.unit}>{field.unit}</Text>}
          </View>
        )}

        {field.type === 'text' && (
          <TextInput
            style={[styles.input, styles.inputMultiline, locked && styles.inputLocked]}
            editable={!locked}
            multiline
            value={typeof value === 'string' ? value : ''}
            placeholder="Type here"
            placeholderTextColor="#94A3B8"
            // Return closes the keyboard. The accessory bar cannot be used here:
            // iOS does not support it on multiline inputs.
            {...multilineDoneProps}
            onChangeText={(t) => setAnswer(field.id, t)}
          />
        )}

        {field.type === 'signature' && (
          <Pressable
            style={[styles.signature, value != null && styles.signatureSigned]}
            onPress={() =>
              setAnswer(field.id, value == null ? `sig_${Date.now()}` : null)
            }
          >
            <Text style={[styles.signatureText, value != null && styles.signatureTextSigned]}>
              {value != null ? '✓  Signed' : 'Tap to sign'}
            </Text>
          </Pressable>
        )}

        {/* An answer that demands evidence says so, and says where it goes.
            It cannot be photographed from here: a picture taken while standing
            over the checklist is a picture of wherever the inspector happened
            to stop, filed as though it were the defect. */}
        {photoDemanded && field.type !== 'photo' && generalPhotos.length === 0 && (
          <Text style={styles.photoDemand}>
            Needs a photograph — use Take a photo on the map screen
          </Text>
        )}

        {/* The photographs themselves, in the one section that holds them. */}
        {field.type === 'photo' && (
          <View style={styles.photoBlock}>
            {photos.length === 0 && (
              <Text style={styles.photoEmpty}>
                At least one is needed, whatever you found. Take a photo on the
                map screen and it appears here, tagged with the distance along
                the drain.
              </Text>
            )}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.photoRow}>
                {photos.map((p) => (
                  <View key={p.id} style={styles.shot}>
                    <View style={styles.thumb}>
                      <Image source={{ uri: p.uri }} style={styles.thumbImg} />
                      {/* A visible control, not a long press. Deleting a
                          photograph was discoverable only by holding one down
                          and hoping — which is no way to remove the blurred
                          shot you have just noticed. Confirmed, because the
                          photograph cannot be taken again from here. */}
                      <Pressable
                        style={styles.thumbDelete}
                        hitSlop={8}
                        onPress={() =>
                          Alert.alert('Delete this photograph?', 'This cannot be undone.', [
                            { text: 'Keep', style: 'cancel' },
                            {
                              text: 'Delete',
                              style: 'destructive',
                              onPress: () => removePhoto(p.id),
                            },
                          ])
                        }
                      >
                        <Text style={styles.thumbDeleteText}>✕</Text>
                      </Pressable>
                    </View>
                    {/* Under the photograph, not printed across the bottom of
                        it. A caption sitting on the image hides the part of the
                        drain nearest the camera, which is usually the part the
                        photograph was taken for. Always shown, so one with no
                        location is visibly missing rather than merely silent. */}
                    <Text
                      style={[styles.shotTag, p.chainage_m == null && styles.shotTagMissing]}
                    >
                      {p.chainage_m != null ? `${p.chainage_m.toFixed(0)} m` : 'no location'}
                    </Text>
                  </View>
                ))}
                <Pressable style={styles.addPhoto} onPress={() => openCamera(field.id)}>
                  <Text style={styles.addPhotoPlus}>＋</Text>
                  <Text style={styles.addPhotoText}>Photo</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        )}

        {err && <Text style={styles.errorText}>{err.message}</Text>}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        {/* The same pill as All jobs on the map screen. Two ways back that
            look like two different kinds of control is one to learn twice. */}
        <Pressable onPress={() => navigation.goBack()} hitSlop={12} style={styles.backRow}>
          <Text style={styles.backChevron}>‹</Text>
          <Text style={styles.back}>Map</Text>
        </Pressable>
        {/* The drain, and nothing else. The template's own title named the form
            an inspector is already looking at, and the reference named a row in
            a database they will never type. */}
        <Text style={styles.title} numberOfLines={2}>
          {job.asset.name}
        </Text>
        <View style={[styles.covBanner, coverageMet && !override && styles.covBannerOk]}>
          <Text style={[styles.covText, coverageMet && !override && styles.covTextOk]}>
            {override
              ? `Submitting at ${coveragePct.toFixed(0)}% — ${String(override.reason_code).replace(/_/g, ' ')}`
              : coverageMet
                ? `✓  Coverage ${coveragePct.toFixed(0)}% — ready to submit`
                : `Coverage ${coveragePct.toFixed(0)}% of ${gate}% — keep walking the drain`}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        // Scrolling away from a field puts the keyboard down, which is what an
        // inspector expects when they move on to the next question.
        keyboardDismissMode="on-drag"
      >
        {(template.sections ?? [{ id: '_', title: '' }]).map((section) => {
          const inSection = fields.filter(
            (f) => (f.section_id ?? '_') === section.id,
          );
          if (inSection.length === 0) return null;
          return (
            <View key={section.id} style={styles.section}>
              {section.title !== '' && (
                <Text style={styles.sectionTitle}>{section.title}</Text>
              )}
              {inSection.map(renderField)}
            </View>
          );
        })}

        {errors.length > 0 && (
          <View style={styles.errorSummary}>
            <Text style={styles.errorSummaryTitle}>
              {errors.length} {errors.length === 1 ? 'problem' : 'problems'} to fix
            </Text>
            {errors.map((e) => (
              <Text key={e.field_id + e.code} style={styles.errorSummaryItem}>
                • {e.message}
              </Text>
            ))}
          </View>
        )}

        <Pressable
          style={[styles.submit, !coverageMet && styles.submitBlocked]}
          onPress={submit}
          disabled={!coverageMet}
        >
          <Text style={styles.submitText}>
            {coverageMet
              ? 'Submit inspection'
              : `${(gate - coveragePct).toFixed(0)}% more coverage needed`}
          </Text>
        </Pressable>

        {!coverageMet && (
          <>
            <Pressable style={styles.backToMap} onPress={() => navigation.goBack()}>
              <Text style={styles.backToMapText}>‹ Back to map — keep walking</Text>
            </Pressable>
            {/* The escape hatch. Without it an inspector at a locked gate must
                either fake the walk or abandon the job. */}
            {job.inspection_rules.allow_override && (
              <Pressable
                style={styles.overrideLink}
                onPress={() => navigation.navigate('Override')}
              >
                <Text style={styles.overrideLinkText}>
                  Can't complete the walk? Submit with a reason
                </Text>
              </Pressable>
            )}
          </>
        )}
      </ScrollView>

      <KeyboardDone />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F1F5F9' },
  header: { paddingHorizontal: 20, paddingBottom: 14, gap: 4 },
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

  body: { padding: 16, paddingBottom: 48, gap: 18 },
  section: { gap: 10 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 6,
  },

  field: { backgroundColor: '#fff', borderRadius: 14, padding: 14, gap: 8 },
  fieldError: { borderWidth: 1.5, borderColor: '#FCA5A5' },
  label: { fontSize: 15, fontWeight: '600', color: '#0F172A' },
  required: { color: '#DC2626' },
  help: { fontSize: 12, color: '#64748B', marginTop: -4 },
  errorText: { fontSize: 12, color: '#B91C1C', fontWeight: '600' },

  optionList: { gap: 6 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    borderRadius: 10,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  optionActive: { backgroundColor: '#EFF6FF', borderColor: '#2563EB' },
  optionLocked: { backgroundColor: '#F1F5F9', borderColor: '#CBD5E1' },
  lockNote: { fontSize: 12, color: '#B45309', fontWeight: '700', marginTop: -2 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#CBD5E1',
  },
  radioActive: { borderColor: '#2563EB', borderWidth: 6 },
  optionText: { fontSize: 14, color: '#334155', flex: 1 },
  optionTextActive: { color: '#1E40AF', fontWeight: '600' },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  chipActive: { backgroundColor: '#1E293B', borderColor: '#1E293B' },
  chipText: { fontSize: 13, color: '#475569', fontWeight: '500' },
  chipTextActive: { color: '#fff' },

  severityRow: { flexDirection: 'row', gap: 8 },
  severityBox: {
    flex: 1,
    aspectRatio: 1.4,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  severityText: { fontSize: 17, fontWeight: '700', color: '#64748B' },
  severityTextActive: { color: '#fff' },

  numberRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: '#0F172A',
  },
  inputLocked: { backgroundColor: '#F1F5F9', color: '#64748B' },
  inputMultiline: { minHeight: 76, textAlignVertical: 'top' },
  unit: { fontSize: 14, color: '#64748B', fontWeight: '600' },

  signature: {
    paddingVertical: 18,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#CBD5E1',
    alignItems: 'center',
  },
  signatureSigned: { borderStyle: 'solid', borderColor: '#16A34A', backgroundColor: '#F0FDF4' },
  signatureText: { fontSize: 14, color: '#64748B', fontWeight: '600' },
  signatureTextSigned: { color: '#15803D' },

  photoBlock: { gap: 8 },
  photoDemand: { fontSize: 12, color: '#B45309', fontWeight: '700' },
  photoEmpty: { fontSize: 12.5, color: '#64748B', lineHeight: 17 },
  // flex-start, so the add button keeps its square shape beside a thumbnail
  // that is now a little taller than it is.
  photoRow: { flexDirection: 'row', gap: 8, paddingVertical: 2, alignItems: 'flex-start' },
  shot: { width: 72, alignItems: 'center', gap: 3 },
  shotTag: { fontSize: 11, fontWeight: '700', color: '#475569' },
  shotTagMissing: { color: '#B45309', fontWeight: '600' },
  thumb: { width: 72, height: 72, borderRadius: 10, overflow: 'hidden', backgroundColor: '#E2E8F0' },
  thumbDelete: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(15,23,42,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbDeleteText: { color: '#fff', fontSize: 11, fontWeight: '800', lineHeight: 13 },
  thumbImg: { width: '100%', height: '100%' },
  addPhoto: {
    width: 72,
    height: 72,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPhotoPlus: { fontSize: 20, color: '#64748B', lineHeight: 24 },
  addPhotoText: { fontSize: 11, color: '#64748B', fontWeight: '600' },

  errorSummary: { backgroundColor: '#FEF2F2', borderRadius: 12, padding: 14, gap: 4 },
  errorSummaryTitle: { fontSize: 14, fontWeight: '700', color: '#B91C1C' },
  errorSummaryItem: { fontSize: 13, color: '#991B1B' },

  submit: {
    backgroundColor: '#0F172A',
    paddingVertical: 17,
    borderRadius: 14,
    alignItems: 'center',
  },
  submitBlocked: { backgroundColor: '#94A3B8' },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  backToMap: { alignItems: 'center', paddingVertical: 12 },
  backToMapText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
  overrideLink: { alignItems: 'center', paddingVertical: 8 },
  overrideLinkText: { color: '#B45309', fontSize: 14, fontWeight: '700' },

  covBanner: {
    marginTop: 10,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  covBannerOk: { backgroundColor: '#DCFCE7' },
  covText: { fontSize: 12, fontWeight: '700', color: '#92400E' },
  covTextOk: { color: '#15803D' },
});
