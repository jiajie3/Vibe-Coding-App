import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';

import { completeness } from '../core/checklist.ts';
import { toLatLng } from '../core/geo.ts';
import { getJob } from '../data/jobs.ts';
import { getTemplate } from '../data/templates.ts';
import { useInspection } from '../hooks/useInspection.ts';
import {
  getCurrentLocation,
  IS_EXPO_GO,
  supportsBackgroundTracking,
} from '../services/locationTask.ts';
import { useSession } from '../state/session.ts';

const UNCOVERED = '#94A3B8';
const COVERED = '#16A34A';
const WALKED = '#2563EB';

/**
 * Google Maps on Android, Apple Maps on iOS.
 *
 * Forcing PROVIDER_GOOGLE on iOS would require bundling the Google Maps iOS SDK
 * and a second API key, and it cannot work in Expo Go at all. Apple Maps is the
 * platform default, needs no key, and renders Singapore just as well.
 */
const MAP_PROVIDER = Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined;

export default function InspectionScreen({
  navigation,
  route,
}: {
  navigation: any;
  route: any;
}) {
  const job = getJob(route.params.jobId)!;
  const mapRef = useRef<MapView>(null);

  const insp = useInspection(job);
  const session = useSession();
  const template = useMemo(
    () => getTemplate(job.checklist_template.id, job.checklist_template.version),
    [job],
  );

  const alignment = useMemo(() => toLatLng(job.asset.geometry.coordinates), [job]);

  /** Frame the whole drain, with a little breathing room. */
  const region = useMemo(() => {
    const lats = alignment.map((p) => p.latitude);
    const lons = alignment.map((p) => p.longitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLon + maxLon) / 2,
      latitudeDelta: Math.max((maxLat - minLat) * 1.4, 0.004),
      longitudeDelta: Math.max((maxLon - minLon) * 1.4, 0.004),
    };
  }, [alignment]);

  const running = insp.status === 'running';
  const started = insp.status !== 'idle';
  const pct = insp.coverage;
  const gate = job.inspection_rules.min_coverage_pct;
  const formProgress = completeness(template, session.answers);

  /**
   * Follow the inspection, not the handset.
   *
   * `followsUserLocation` tracks the device's own GPS, which during a simulated
   * walk is wherever the phone actually is — so the map kept yanking back to the
   * office instead of staying on the drain. Centring on the last accepted fix
   * works for both real and simulated tracking.
   */
  const [following, setFollowing] = useState(true);
  const lastPanned = useRef(0);

  useEffect(() => {
    if (!running || !following || !insp.lastFix) return;
    // Fixes can arrive every ~120 ms in simulation; animating each one makes the
    // map unreadable and burns frames.
    const now = Date.now();
    if (now - lastPanned.current < 1500) return;
    lastPanned.current = now;

    mapRef.current?.animateCamera(
      { center: { latitude: insp.lastFix.lat, longitude: insp.lastFix.lon } },
      { duration: 600 },
    );
  }, [running, following, insp.lastFix]);

  const [locating, setLocating] = useState(false);

  /**
   * Go to the drain, and resume following it.
   *
   * Before an inspection starts there is no walk to follow, so it frames the
   * whole alignment — which is what you want when working out where the drain
   * is and how to reach it. Once walking, it snaps to wherever the walk has
   * reached and re-engages auto-follow.
   */
  const goToDrain = () => {
    setFollowing(true);
    lastPanned.current = 0;
    if (insp.lastFix) {
      mapRef.current?.animateCamera(
        { center: { latitude: insp.lastFix.lat, longitude: insp.lastFix.lon } },
        { duration: 400 },
      );
    } else {
      mapRef.current?.animateToRegion(region, 400);
    }
  };

  /**
   * Centre on the handset, not the inspection.
   *
   * Following is switched off first: the point of this button is to look at
   * where you actually are — usually to work out how to reach the drain, or
   * which end you are standing at — and the auto-follow would drag the camera
   * away a second later.
   */
  const goToMyLocation = async () => {
    setLocating(true);
    setFollowing(false);
    try {
      const pos = await getCurrentLocation();
      if (!pos) {
        Alert.alert(
          'Location unavailable',
          'CFPI needs location access, and a GPS fix, to show where you are.',
        );
        return;
      }
      mapRef.current?.animateCamera(
        { center: { latitude: pos.lat, longitude: pos.lon }, zoom: 17 },
        { duration: 500 },
      );
    } finally {
      setLocating(false);
    }
  };

  /**
   * Where to drive to: the start of the drain, or the first stretch still
   * unwalked.
   *
   * Resuming a part-finished inspection days later is the case that matters.
   * Sending the inspector back to the start of a drain they already walked
   * 300 m of wastes the trip — they need the point they stopped at.
   */
  const navTarget = useMemo(() => {
    const gaps = insp.uncoveredRanges;
    if (insp.status === 'idle' || gaps.length === 0 || gaps[0][0] < 1) {
      const [lon, lat] = job.asset.geometry.coordinates[0];
      return { lat, lon, label: 'Navigate to start' };
    }
    const p = insp.pointAt(gaps[0][0]);
    return { lat: p.lat, lon: p.lon, label: `Navigate to ${gaps[0][0].toFixed(0)} m` };
  }, [insp, job]);

  /**
   * Hand the target to Google Maps for turn-by-turn navigation.
   *
   * CFPI's map shows where the drain is; it knows nothing about roads, traffic
   * or one-way systems, and building that would be rebuilding a navigation app
   * badly. Getting to site is a solved problem — hand it off.
   *
   * The universal https URL rather than a `comgooglemaps://` scheme: it opens
   * the Google Maps app when installed and falls back to the browser when not,
   * instead of failing outright on a handset without it.
   */
  const navigate = async () => {
    const url =
      `https://www.google.com/maps/dir/?api=1&destination=${navTarget.lat},${navTarget.lon}` +
      `&travelmode=driving`;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert(
        'Could not open Maps',
        `${navTarget.lat.toFixed(5)}, ${navTarget.lon.toFixed(5)}`,
      );
    }
  };

  /**
   * Guard every exit route, not just the back button.
   *
   * `beforeRemove` also catches the iOS swipe-back gesture and the Android
   * hardware back button. Handling only the button would let those two paths
   * leave the GPS foreground service running — still recording the inspector's
   * location after they think they have left the job.
   *
   * Nothing is lost either way: leaving pauses and saves. The prompt exists so
   * the inspector knows tracking stopped, not to warn them about data loss.
   */
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e: any) => {
      if (!running) return;
      e.preventDefault();
      Alert.alert(
        'Pause this inspection?',
        `Tracking will stop. Your ${pct.toFixed(0)}% coverage is saved — you can resume this job later, even on another day.`,
        [
          { text: 'Stay', style: 'cancel' },
          {
            text: 'Pause and leave',
            onPress: async () => {
              await insp.pause();
              navigation.dispatch(e.data.action);
            },
          },
        ],
      );
    });
    return unsub;
  }, [navigation, running, pct, insp]);

  return (
    <View style={styles.screen}>
      <MapView
        ref={mapRef}
        provider={MAP_PROVIDER}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        showsUserLocation
        showsMyLocationButton
        mapType="hybrid"
        // Panning means the inspector is looking at something specific — often
        // a gap they need to go back for. Yanking the camera away mid-look is
        // worse than losing the follow.
        onPanDrag={() => setFollowing(false)}
      >
        {/* The drain, as published by FRCDE. Grey until walked. */}
        <Polyline coordinates={alignment} strokeColor={UNCOVERED} strokeWidth={9} zIndex={1} />

        {/* Covered stretches, painted over the base line as they are walked.
            Sliced along the real alignment, so they follow every bend. */}
        {insp.coveredPaths.map((path, i) => (
          <Polyline
            key={`cov-${i}`}
            coordinates={path}
            strokeColor={COVERED}
            strokeWidth={9}
            zIndex={2}
          />
        ))}

        {/* Where the inspector actually walked — deliberately distinct from
            coverage. Seeing the two diverge is how you spot walking the wrong
            side of a fence. */}
        {insp.walkedPath.length > 1 && (
          <Polyline
            coordinates={insp.walkedPath}
            strokeColor={WALKED}
            strokeWidth={3}
            zIndex={3}
          />
        )}

        <Marker coordinate={alignment[0]} title="Start" pinColor="#16A34A" />
        <Marker coordinate={alignment[alignment.length - 1]} title="End" pinColor="#DC2626" />
      </MapView>

      {/* ---------------------------------------------------------- HUD */}
      <SafeAreaView edges={['top']} pointerEvents="box-none">
        <View style={styles.hud}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={14} style={styles.backRow}>
            <Text style={styles.back}>‹ All jobs</Text>
          </Pressable>

          <View style={styles.titleRow}>
            <Text style={styles.hudRef}>{job.reference}</Text>
            {insp.status === 'paused' && (
              <View style={styles.pausedPill}>
                <Text style={styles.pausedPillText}>PAUSED</Text>
              </View>
            )}
          </View>
          <Text style={styles.hudName} numberOfLines={1}>
            {job.asset.name}
          </Text>

          <View style={styles.coverageRow}>
            <Text style={[styles.pct, pct >= gate && styles.pctGood]}>
              {pct.toFixed(0)}
              <Text style={styles.pctSign}>%</Text>
            </Text>
            <View style={styles.coverageMeta}>
              <Text style={styles.metaLabel}>covered · {gate}% required to submit</Text>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    { width: `${Math.min(pct, 100)}%` },
                    pct >= gate && styles.barFillGood,
                  ]}
                />
                <View style={[styles.barGate, { left: `${gate}%` }]} />
              </View>
              <Text style={styles.metaLabel}>
                {insp.chainage != null
                  ? `chainage ${insp.chainage.toFixed(0)} / ${job.asset.length_m.toFixed(0)} m`
                  : `${job.asset.length_m.toFixed(0)} m total`}
                {insp.lastFix?.acc != null && ` · ±${insp.lastFix.acc.toFixed(0)} m`}
              </Text>
            </View>
          </View>

          {insp.rejected && running && (
            <View style={styles.warn}>
              <Text style={styles.warnText}>
                {insp.rejected === 'outside_corridor'
                  ? 'Off the drain — move back onto the alignment'
                  : insp.rejected === 'poor_accuracy'
                    ? 'Weak GPS signal — fixes are not counting'
                    : 'Waiting for a usable GPS fix'}
              </Text>
            </View>
          )}

          {!supportsBackgroundTracking && running && (
            <View style={styles.note}>
              <Text style={styles.noteText}>
                Expo Go — keep the screen on. Tracking pauses if you lock the phone.
              </Text>
            </View>
          )}

          {insp.flags.length > 0 && (
            <View style={styles.flagRow}>
              {insp.flags.map((f) => (
                <View key={f} style={styles.flag}>
                  <Text style={styles.flagText}>{f.replace(/_/g, ' ')}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </SafeAreaView>

      {/* ------------------------------------------------------- controls */}
      <SafeAreaView style={styles.bottom} edges={['bottom']} pointerEvents="box-none">
        {/* Both always available, including before the inspection starts —
            finding the drain and finding yourself are the two things an
            inspector does on arrival, before anything is running. */}
        <View style={styles.mapControls}>
          <Pressable style={styles.mapBtn} onPress={goToDrain}>
            <Text style={styles.mapBtnText}>◎  Drain location</Text>
          </Pressable>
          <Pressable style={styles.mapBtn} onPress={goToMyLocation} disabled={locating}>
            <Text style={styles.mapBtnText}>
              {locating ? 'Locating…' : '➤  My location'}
            </Text>
          </Pressable>

          {/* Only while not walking. Mid-inspection the inspector is already at
              the drain, and a button that leaves the app for a navigation route
              to where they are standing is noise. It returns on pause — which
              is exactly when someone is coming back another day. */}
          {!running && (
            <Pressable style={[styles.mapBtn, styles.mapBtnNav]} onPress={navigate}>
              <Text style={styles.mapBtnText}>↗  {navTarget.label}</Text>
            </Pressable>
          )}
        </View>

        {insp.uncoveredRanges.length > 0 && started && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.gapRow}
          >
            <Text style={styles.gapLabel}>Missed:</Text>
            {insp.uncoveredRanges.map(([a, b], i) => (
              <View key={i} style={styles.gapChip}>
                <Text style={styles.gapChipText}>
                  {a.toFixed(0)}–{b.toFixed(0)} m
                </Text>
              </View>
            ))}
          </ScrollView>
        )}

        {/* The checklist is available throughout the walk, not only after it.
            Defects are recorded where they are seen — asking an inspector to
            remember six of them until the end guarantees losing some. */}
        {started && (
          <Pressable
            style={styles.checklistBtn}
            onPress={() => navigation.navigate('Checklist')}
          >
            <View style={styles.checklistLeft}>
              <Text style={styles.checklistTitle}>Checklist &amp; submit</Text>
              <Text style={styles.checklistSub}>
                {Math.round(formProgress * 100)}% filled · {session.photos.length}{' '}
                {session.photos.length === 1 ? 'photo' : 'photos'}
              </Text>
            </View>
            <View style={[styles.readyPill, insp.canSubmit && styles.readyPillOk]}>
              <Text style={[styles.readyText, insp.canSubmit && styles.readyTextOk]}>
                {insp.canSubmit ? 'Ready' : `${(gate - pct).toFixed(0)}% short`}
              </Text>
            </View>
          </Pressable>
        )}

        <View style={styles.buttonRow}>
          {running ? (
            <Pressable style={[styles.btn, styles.btnPause]} onPress={insp.pause}>
              <Text style={styles.btnText}>Pause inspection</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.btn, styles.btnStart]} onPress={insp.start}>
              <Text style={styles.btnText}>
                {insp.status === 'paused' ? 'Resume inspection' : 'Start inspection'}
              </Text>
            </Pressable>
          )}

          {/*
            * Simulate a walk instead of doing one.
            *
            * Not gated on __DEV__ alone. An EAS Update ships a production bundle,
            * where __DEV__ is false, so gating on it meant the button existed on
            * the laptop and vanished for every colleague opening the shared link —
            * with no way to reach the coverage engine at all, since Expo Go cannot
            * track location in the background either.
            *
            * Expo Go is the honest condition. There, tracking only runs while the
            * app is on screen, so an inspection cannot realistically be walked and
            * this is the only way the app functions. A real build is not Expo Go,
            * and the button disappears on its own — which is the important half:
            * a "pretend you walked the drain" control must never reach an
            * inspector holding a phone in the field.
            */}
          {(__DEV__ || IS_EXPO_GO) && !running && (
            <Pressable style={[styles.btn, styles.btnSim]} onPress={() => insp.simulate()}>
              <Text style={styles.btnSimText}>Simulate</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0F172A' },

  hud: {
    margin: 12,
    padding: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.96)',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  backRow: { alignSelf: 'flex-start', marginBottom: 6 },
  back: { fontSize: 15, color: '#2563EB', fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hudRef: { fontSize: 11, fontWeight: '700', color: '#94A3B8', letterSpacing: 0.6 },
  pausedPill: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
  },
  pausedPillText: { fontSize: 9, fontWeight: '800', color: '#92400E', letterSpacing: 0.6 },
  hudName: { fontSize: 17, fontWeight: '700', color: '#0F172A', marginTop: 2 },

  coverageRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 14 },
  pct: { fontSize: 44, fontWeight: '800', color: '#334155', letterSpacing: -2 },
  pctGood: { color: COVERED },
  pctSign: { fontSize: 20, fontWeight: '700' },
  coverageMeta: { flex: 1, gap: 5 },
  metaLabel: { fontSize: 11, color: '#64748B', fontWeight: '500' },

  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  barFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#64748B' },
  barFillGood: { backgroundColor: COVERED },
  barGate: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#0F172A' },

  warn: { marginTop: 10, backgroundColor: '#FEF2F2', borderRadius: 8, padding: 8 },
  warnText: { fontSize: 12, color: '#B91C1C', fontWeight: '600' },

  note: { marginTop: 8, backgroundColor: '#EFF6FF', borderRadius: 8, padding: 8 },
  noteText: { fontSize: 11, color: '#1D4ED8', fontWeight: '600' },

  flagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  flag: { backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  flagText: { fontSize: 10, color: '#92400E', fontWeight: '700', textTransform: 'uppercase' },

  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, gap: 10 },
  mapControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  mapBtn: {
    backgroundColor: 'rgba(15,23,42,0.85)',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
  },
  mapBtnNav: { backgroundColor: 'rgba(37,99,235,0.9)' },
  mapBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  gapRow: { gap: 6, alignItems: 'center', paddingVertical: 2 },
  gapLabel: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
  gapChip: {
    backgroundColor: 'rgba(220,38,38,0.92)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  gapChipText: { fontSize: 12, color: '#FFFFFF', fontWeight: '700' },

  checklistBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  checklistLeft: { gap: 2 },
  checklistTitle: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  checklistSub: { fontSize: 12, color: '#64748B' },
  readyPill: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  readyPillOk: { backgroundColor: '#DCFCE7' },
  readyText: { fontSize: 12, fontWeight: '700', color: '#64748B' },
  readyTextOk: { color: '#15803D' },

  buttonRow: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1,
    paddingVertical: 17,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnStart: { backgroundColor: COVERED },
  btnPause: { backgroundColor: '#D97706' },
  btnSim: { flex: 0, paddingHorizontal: 20, backgroundColor: 'rgba(255,255,255,0.9)' },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  btnSimText: { color: '#0F172A', fontSize: 14, fontWeight: '700' },
});
