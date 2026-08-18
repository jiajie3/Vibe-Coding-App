/**
 * FRCDE HTTP client.
 *
 * Thin on purpose. Retries, ordering and persistence are the outbox's job — this
 * module only knows how to make one request and classify the failure.
 */

import { File } from 'expo-file-system';

import type { Job } from '../core/types.ts';
import { uuidv7 } from '../core/uuid.ts';
import { getAccessToken, refreshSession } from './auth.ts';
import { getConfig } from './config.ts';

/**
 * Distinguishing these two is the whole basis of the retry policy.
 *
 * `permanent` means the request will fail identically forever — a malformed
 * body, a job that no longer exists. Retrying burns battery until the phone
 * dies. `transient` means try again later: no signal, server restarting, 500.
 */
export type FailureKind = 'transient' | 'permanent' | 'conflict' | 'auth';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: FailureKind,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

function classify(status: number): FailureKind {
  if (status === 409) return 'conflict';
  // 401 survived a refresh attempt, so nobody is signed in — hold the work and
  // retry after sign-in rather than discarding it. 403 is different: this
  // account may not do this, and retrying will never change that.
  if (status === 401) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  if (status >= 400) return 'permanent';
  return 'transient';
}

async function once<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const base = getConfig().server_url;
  if (!base) throw new ApiError('No server configured', 0, 'permanent');

  // Without a timeout a request on a dead Wi-Fi hangs until the OS gives up,
  // which can be a minute or more — long enough to look like a frozen app.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const token = getAccessToken();

  try {
    const res = await fetch(base + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(
        (body as { detail?: string; title?: string })?.detail ??
          (body as { title?: string })?.title ??
          `${res.status} ${res.statusText}`,
        res.status,
        classify(res.status),
        body,
      );
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // Aborts and network errors are always worth retrying.
    throw new ApiError(
      e instanceof Error ? e.message : 'Network error',
      0,
      'transient',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make a request, refreshing the token once if it has expired.
 *
 * A 30-minute access token will routinely be stale when the outbox finally gets
 * signal, so an expired token is an ordinary event rather than an error. If the
 * refresh also fails the 401 propagates as `auth` and the app asks for a new
 * sign-in — the queued work is untouched and syncs once someone signs back in.
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  try {
    return await once<T>(path, init, timeoutMs);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await refreshSession())) {
      return await once<T>(path, init, timeoutMs);
    }
    throw e;
  }
}

// Not `crypto.randomUUID()` — that is a Node/browser global and Hermes has no
// `crypto` object at all. uuidv7 is pure JS and is what the contract asks for.
const idem = () => ({ 'Idempotency-Key': uuidv7() });

export const api = {
  // No separate reachability check: fetching the jobs proves the server is
  // there, and one call is one fewer thing to keep in step.
  listJobs: () => request<{ data: Job[] }>('/v1/jobs'),

  /**
   * Claim a job. The one call that cannot be queued for later — two inspectors
   * can tap Accept at the same instant and only the server can arbitrate.
   */
  acceptJob: (jobId: string, version: number) =>
    request<Job>(`/v1/jobs/${jobId}/accept`, {
      method: 'POST',
      headers: { ...idem(), 'If-Match': `"${version}"` },
      body: '{}',
    }),

  startInspection: (jobId: string, body: unknown) =>
    request<{ id: string }>(`/v1/jobs/${jobId}/inspections`, {
      method: 'POST',
      headers: idem(),
      body: JSON.stringify(body),
    }),

  postTrack: (inspectionId: string, body: unknown) =>
    request<{ accepted_points: number; server_coverage_pct: number }>(
      `/v1/inspections/${inspectionId}/track`,
      { method: 'POST', headers: idem(), body: JSON.stringify(body) },
    ),

  // Plain path segment, no colon — see the note on the server route.
  presign: (inspectionId: string, body: unknown) =>
    request<{ upload_url: string }>(
      `/v1/inspections/${inspectionId}/attachments/presign`,
      { method: 'POST', headers: idem(), body: JSON.stringify(body) },
    ),

  confirmAttachment: (inspectionId: string, body: unknown) =>
    request<unknown>(`/v1/inspections/${inspectionId}/attachments`, {
      method: 'POST',
      headers: idem(),
      body: JSON.stringify(body),
    }),

  complete: (inspectionId: string, body: unknown) =>
    request<{ server_coverage_pct: number; flags: string[] }>(
      `/v1/inspections/${inspectionId}/complete`,
      { method: 'POST', headers: idem(), body: JSON.stringify(body) },
    ),

  /** Best-effort progress ping. Never queued — a stale heartbeat is worse than none. */
  heartbeat: (jobId: string, body: unknown) =>
    request<void>(`/v1/jobs/${jobId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, 5000),
};

/**
 * Upload raw bytes to a presigned URL. Bypasses the JSON client entirely.
 *
 * Reads through expo-file-system rather than `fetch('file://…')`. React Native's
 * fetch handles local file URIs inconsistently across platforms, and a photo
 * that silently uploads as zero bytes is a nasty failure to diagnose later.
 */
export async function uploadBytes(url: string, uri: string): Promise<void> {
  const bytes = await new File(uri).bytes();
  const res = await fetch(url, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': 'image/jpeg' },
  });
  if (!res.ok) {
    throw new ApiError(`Upload failed: ${res.status}`, res.status, classify(res.status));
  }
}
