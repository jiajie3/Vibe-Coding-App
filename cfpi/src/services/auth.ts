/**
 * Sign-in and token lifecycle.
 *
 * Tokens live in expo-secure-store (Keychain / Android Keystore) rather than the
 * plain JSON the rest of the device state uses — they are credentials, and a
 * lost handset should not hand over a working session with the filesystem.
 *
 * The refresh token is what makes a shift possible: the access token lasts 30
 * minutes, which is nothing to an inspector who has been in a culvert for three
 * hours. The app stays usable offline the whole time; only *sync* needs a live
 * token, and that is exactly when connectivity exists to refresh one.
 */

import * as SecureStore from 'expo-secure-store';

import { getConfig } from './config.ts';

const ACCESS_KEY = 'cfpi.access_token';
const REFRESH_KEY = 'cfpi.refresh_token';

export interface Inspector {
  id: string;
  name: string;
  username: string;
  role: 'inspector' | 'supervisor';
  depot: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  inspector: Inspector;
}

let accessToken: string | null = null;
let refreshToken: string | null = null;
let inspector: Inspector | null = null;
let loaded = false;

const listeners = new Set<() => void>();
export function onAuthChange(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const notify = () => listeners.forEach((l) => l());

async function put(key: string, value: string | null) {
  if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value);
}

/** Restore a session from secure storage. Call once at startup. */
export async function loadSession(): Promise<boolean> {
  if (loaded) return accessToken !== null;
  loaded = true;
  try {
    accessToken = await SecureStore.getItemAsync(ACCESS_KEY);
    refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
  } catch {
    accessToken = null;
    refreshToken = null;
  }
  notify();
  return accessToken !== null;
}

export const getAccessToken = () => accessToken;
export const getInspector = () => inspector;

/**
 * True when the app has a session.
 *
 * There is one kind now. A demo mode used to count as signed in for the UI
 * while holding the outbox shut, so half the app had to ask which sort of
 * session it was looking at — and an inspection recorded in it went nowhere,
 * which is a worse first impression than a sign-in screen.
 */
export const isSignedIn = () => accessToken !== null;

async function store(t: TokenResponse) {
  accessToken = t.access_token;
  refreshToken = t.refresh_token;
  inspector = t.inspector;
  await put(ACCESS_KEY, t.access_token);
  await put(REFRESH_KEY, t.refresh_token);
  notify();
}

export async function signIn(username: string, password: string, deviceId: string) {
  const base = getConfig().server_url;
  if (!base) throw new Error('Set the FRCDE server address first');

  const res = await fetch(`${base}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, device_id: deviceId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body as { detail?: string })?.detail ?? 'Username or password is incorrect',
    );
  }
  await store((await res.json()) as TokenResponse);
}

/**
 * Exchange the refresh token for a new pair.
 *
 * Guarded against concurrent callers: the outbox can have several requests fail
 * on 401 at once, and each racing to refresh would rotate the token out from
 * under the others and log the inspector out mid-shift.
 */
let refreshing: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const base = getConfig().server_url;
    if (!base || !refreshToken) return false;
    try {
      const res = await fetch(`${base}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        // The refresh token itself is dead — the session is genuinely over.
        await signOut();
        return false;
      }
      await store((await res.json()) as TokenResponse);
      return true;
    } catch {
      // Network failure, not an auth failure. Keep the session; try later.
      return false;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

export async function signOut() {
  const base = getConfig().server_url;
  const token = refreshToken;
  accessToken = null;
  refreshToken = null;
  inspector = null;
  await put(ACCESS_KEY, null);
  await put(REFRESH_KEY, null);
  notify();

  // Best effort — the local session is already gone either way.
  if (base && token) {
    fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: token }),
    }).catch(() => {});
  }
}
