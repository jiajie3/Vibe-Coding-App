/**
 * Device settings.
 *
 * The FRCDE address ships with the build so a colleague opening a shared link
 * is already pointed at the server and only has to sign in — but it stays
 * editable, because during development it is a laptop on a changing network and
 * rebuilding the app for every new DHCP lease would be absurd.
 */

import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';

export interface Config {
  /** e.g. https://frcde.onrender.com — no trailing slash. */
  server_url: string;
  /**
   * Stable per-install identifier, so FRCDE can revoke one lost handset without
   * disabling the person who was carrying it.
   */
  device_id: string;
}

/** Set in app.json under `expo.extra.frcdeUrl`, baked into the published bundle. */
const BUNDLED_SERVER_URL = String(
  (Constants.expoConfig?.extra as { frcdeUrl?: string } | undefined)?.frcdeUrl ?? '',
).replace(/\/+$/, '');

const DEFAULTS: Config = { server_url: BUNDLED_SERVER_URL, device_id: '' };

let cache: Config | null = null;

function file(): File {
  const dir = new Directory(Paths.document, 'config');
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, 'settings.json');
}

export function getConfig(): Config {
  if (cache) return cache;
  try {
    const f = file();
    cache = f.exists
      ? { ...DEFAULTS, ...(JSON.parse(f.textSync()) as Partial<Config>) }
      : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setConfig(patch: Partial<Config>): Config {
  const next = { ...getConfig(), ...patch };
  // Trailing slashes turn every request path into a double slash, which some
  // routers and proxies handle differently. Normalise once, here.
  if (next.server_url) next.server_url = next.server_url.replace(/\/+$/, '');
  cache = next;
  try {
    const f = file();
    if (!f.exists) f.create();
    f.write(JSON.stringify(next));
  } catch (e) {
    console.warn('[config] save failed', e);
  }
  return next;
}

export function isConfigured(): boolean {
  return getConfig().server_url.length > 0;
}
