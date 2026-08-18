/**
 * Device settings.
 *
 * The FRCDE server address has to be editable in the app: it is a laptop on a
 * home Wi-Fi, so the IP changes between sessions. Baking it into a build would
 * mean rebuilding the app every time the router hands out a different lease.
 */

import { Directory, File, Paths } from 'expo-file-system';

export interface Config {
  /** e.g. http://192.168.0.3:4000 — no trailing slash. */
  server_url: string;
  /**
   * Stable per-install identifier, so FRCDE can revoke one lost handset without
   * disabling the person who was carrying it.
   */
  device_id: string;
}

const DEFAULTS: Config = { server_url: '', device_id: '' };

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
