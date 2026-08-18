/**
 * Background location service.
 *
 * One source of GPS truth for the whole app. `startLocationUpdatesAsync` (rather
 * than the simpler `watchPositionAsync`) is what keeps fixes arriving when the
 * phone goes in a pocket and the screen locks — which is most of an inspection.
 *
 * On Android this runs as a foreground service with a persistent notification.
 * That notification is not optional: without it Android kills the service within
 * minutes and the inspector silently loses their track.
 */

import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import type { Fix } from '../core/types.ts';

export const LOCATION_TASK = 'cfpi-inspection-location';

/**
 * Expo Go cannot run background location — no foreground service on Android, and
 * the Expo Go binary does not declare the iOS background location entitlement.
 *
 * Rather than making the app unusable there, we fall back to `watchPositionAsync`,
 * which Expo Go supports. Tracking then works only while CFPI is open and the
 * screen is on. That is fine for a demo walk with the phone in hand, and useless
 * for a real shift — which is exactly why production needs a development build.
 */
export const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** True when tracking survives a screen lock. Drives the warning in the UI. */
export const supportsBackgroundTracking = !IS_EXPO_GO;

type Listener = (fix: Fix) => void;
const listeners = new Set<Listener>();

/**
 * Fixes that arrived before any screen subscribed.
 *
 * The task can fire while the app is backgrounded and React is not mounted.
 * Dropping those fixes would punch holes in coverage for the stretch walked with
 * the screen off, so they queue here and drain on the next subscribe.
 */
let pending: Fix[] = [];

export function onFix(listener: Listener): () => void {
  listeners.add(listener);
  if (pending.length) {
    const queued = pending;
    pending = [];
    queued.forEach(listener);
  }
  return () => {
    listeners.delete(listener);
  };
}

function toFix(loc: Location.LocationObject): Fix {
  return {
    lat: loc.coords.latitude,
    lon: loc.coords.longitude,
    acc: loc.coords.accuracy ?? undefined,
    alt: loc.coords.altitude ?? undefined,
    spd: loc.coords.speed ?? undefined,
    hdg: loc.coords.heading ?? undefined,
    t: new Date(loc.timestamp).toISOString(),
    // Android reports mock providers directly. iOS has no equivalent API, so
    // spoofing detection there has to be server-side plausibility analysis.
    mock: loc.mocked ?? false,
    src: 'gps',
  };
}

// Must be registered at module scope, before React renders — Expo replays tasks
// into a cold JS context on launch and there is no component mounted yet.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[location task]', error.message);
    return;
  }
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  if (!locations?.length) return;

  for (const loc of locations) {
    const fix = toFix(loc);
    if (listeners.size === 0) {
      pending.push(fix);
      if (pending.length > 5000) pending.shift(); // ~14 hours at 10 s; never unbounded
    } else {
      listeners.forEach((l) => l(fix));
    }
  }
});

export type PermissionOutcome =
  | { ok: true; background: boolean }
  | { ok: false; reason: 'foreground_denied' | 'services_disabled' };

/**
 * Request location permissions.
 *
 * Background permission is requested separately and deliberately *after*
 * foreground is granted — Android 11+ rejects a combined request outright, and
 * both platforms show a far higher grant rate when the second prompt arrives with
 * the map already visible and the reason obvious.
 */
export async function requestPermissions(): Promise<PermissionOutcome> {
  if (!(await Location.hasServicesEnabledAsync())) {
    return { ok: false, reason: 'services_disabled' };
  }

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { ok: false, reason: 'foreground_denied' };

  // Asking for background permission in Expo Go prompts the user for something
  // the runtime cannot honour, so skip it and report the limitation honestly.
  if (IS_EXPO_GO) return { ok: true, background: false };

  const bg = await Location.requestBackgroundPermissionsAsync();
  // Background denial is survivable: tracking still works with the screen on.
  // Warn the inspector rather than blocking the inspection.
  return { ok: true, background: bg.status === 'granted' };
}

/** Held only in the Expo Go fallback path. */
let watchSub: Location.LocationSubscription | null = null;

/**
 * One-off read of where the handset actually is.
 *
 * Separate from the inspection track on purpose: this answers "where am I",
 * not "where has the inspection got to". During a simulated walk those are
 * different places, and conflating them is what made the map keep jumping back
 * to the office.
 */
export async function getCurrentLocation(): Promise<{ lat: number; lon: number } | null> {
  const held = await Location.getForegroundPermissionsAsync();
  if (held.status !== 'granted') {
    const asked = await Location.requestForegroundPermissionsAsync();
    if (asked.status !== 'granted') return null;
  }
  try {
    const pos = await Location.getCurrentPositionAsync({
      // Balanced, not BestForNavigation: this is a "show me on the map" tap and
      // a two-second wait for extra precision nobody asked for is worse than a
      // ten-metre error.
      accuracy: Location.Accuracy.Balanced,
    });
    return { lat: pos.coords.latitude, lon: pos.coords.longitude };
  } catch {
    return null;
  }
}

export async function isTracking(): Promise<boolean> {
  if (IS_EXPO_GO) return watchSub !== null;
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
}

export async function startTracking(jobReference: string): Promise<void> {
  if (await isTracking()) return;

  if (IS_EXPO_GO) {
    watchSub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
        timeInterval: 3000,
      },
      // Same emitter as the background task, so everything downstream — the
      // coverage engine, the hook, the map — is identical on both paths.
      (loc) => {
        const fix = toFix(loc);
        listeners.forEach((l) => l(fix));
      },
    );
    return;
  }

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    // Distance-based, not time-based. A stationary inspector filling in the
    // checklist should not generate 360 identical fixes an hour.
    distanceInterval: 5,
    timeInterval: 3000,
    // Batching costs us live map responsiveness, so keep it off during an
    // inspection even though it would save battery.
    deferredUpdatesInterval: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Fitness,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Inspection in progress',
      notificationBody: `Recording your route along ${jobReference}`,
      notificationColor: '#16A34A',
      killServiceOnDestroy: false,
    },
  });

  if (Platform.OS === 'android') {
    // Surfaced so the UI can nudge the inspector to exempt CFPI from battery
    // optimisation. Xiaomi/Oppo/Samsung will otherwise kill the service.
    console.log('[location] foreground service started');
  }
}

export async function stopTracking(): Promise<void> {
  if (IS_EXPO_GO) {
    watchSub?.remove();
    watchSub = null;
    pending = [];
    return;
  }
  if (await isTracking()) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  pending = [];
}
