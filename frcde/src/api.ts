/**
 * Console API client.
 *
 * Vite proxies /v1 to the local server, so there is no base URL and no CORS
 * dance in development.
 */

import type { Job } from '../../cfpi/src/core/types.ts';

export interface Heartbeat {
  inspection_id: string;
  status: 'in_progress' | 'paused';
  coverage_pct: number;
  updated_at: string;
}

export interface JobRecord extends Job {
  heartbeat: Heartbeat | null;
}

export interface Attachment {
  id: string;
  source?: 'camera' | 'library';
  captured_at: string;
  lat: number | null;
  lon: number | null;
  chainage_m: number | null;
  checklist_field_id?: string | null;
  caption?: string;
  stored: boolean;
}

export interface InspectionDetail {
  /** The automated first pass. Absent on older records. */
  ai_review?: AiReview | null;
  id: string;
  job_id: string;
  inspector_id: string | null;
  inspector_name: string | null;
  override: { reason_code: string; notes?: string; photo_ids: string[] } | null;
  status: 'in_progress' | 'submitted' | 'approved' | 'rejected' | 'abandoned';
  started_at: string;
  ended_at: string | null;
  received_at: string;
  supersedes_inspection_id: string | null;
  client_coverage: { client_computed_pct: number } | null;
  server_coverage_pct: number | null;
  flags: string[];
  checklist: {
    template_id: string;
    template_version: number;
    answers: Record<string, unknown>;
  } | null;
  attachments: Attachment[];
  covered_lines: number[][][];
  uncovered_lines: number[][][];
  uncovered_ranges: [number, number][];
  track_line: number[][];
  track_points: number;
  review: { decision: string; reason?: string; at: string } | null;
}

export type WorkOrderStatus =
  | 'open'
  | 'in_progress'
  | 'awaiting_verification'
  | 'done'
  | 'blocked'
  | 'cancelled';

export interface WorkOrder {
  id: string;
  job_id: string;
  inspection_id: string | null;
  title: string;
  assigned_to: string;
  detail: string;
  severity: number;
  due_at: string | null;
  chainage_m: number | null;
  status: WorkOrderStatus;
  raised_by: string;
  raised_at: string;
  closed_at: string | null;
  closing_note?: string;
  attachment_ids: string[];

  /** When the party it went to said they had seen it. Null means nobody has. */
  acknowledged_at: string | null;
  /** Set with status `blocked` — they cannot do it, and said why. */
  blocked_reason?: string;
  /** Where the case was opened, once it has been. */
  slack?: { channel: string; ts: string };
  /** Evidence posted back in the Slack case thread. */
  completion_attachment_ids?: string[];
  /** When the contractor said it was finished — before anyone checked. */
  completed_at?: string | null;
  /** Who signed it off here. */
  verified_by?: string;
  /** Why it was last sent back. The full history is in the Slack thread. */
  sent_back_note?: string;
}

export interface ChannelOption {
  channel: string;
  reason: string;
}

export interface ChannelSuggestion extends ChannelOption {
  confidence: 'high' | 'medium' | 'low';
  alternatives: ChannelOption[];
}

export interface SuggestResponse {
  suggestion: ChannelSuggestion;
  channels: string[];
  /** Channel to the name a case routed there is recorded under. */
  labels: Record<string, string>;
  /** False when no workspace is configured — the post will be simulated. */
  slack_configured: boolean;
}

export interface AiReview {
  verdict: 'looks_sound' | 'needs_a_look' | 'likely_reject' | 'skipped';
  confidence: 'low' | 'medium' | 'high';
  /** The whole answer in prose: what to do about this inspection, and why. */
  explanation: string;
  /** Kept with the verdict so an old review can still be explained. */
  model: string;
  prompt_version: number;
  generated_at: string;
  error?: string;
}

export interface Overview {
  jobs: JobRecord[];
  inspections: InspectionDetail[];
  users: Account[];
  work_orders: WorkOrder[];
  scheduler?: { last_run_at: string; queued: string[]; checked: number };
  stats: {
    total: number;
    available: number;
    in_progress: number;
    submitted: number;
    approved: number;
    overdue: number;
    total_km: number;
  };
}

/* ------------------------------------------------------------------ auth */

export interface Account {
  id: string;
  name: string;
  username: string;
  role: 'inspector' | 'supervisor';
  depot: string;
}

const TOKEN_KEY = 'frcde.access_token';
const REFRESH_KEY = 'frcde.refresh_token';
const ACCOUNT_KEY = 'frcde.account';

/**
 * localStorage, knowingly.
 *
 * A real console would use an httpOnly cookie so a script injection cannot read
 * the token. This is a local mock-up with no third-party scripts, and pretending
 * otherwise would be worse than saying so.
 */
export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  account: (): Account | null => {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY);
      return raw ? (JSON.parse(raw) as Account) : null;
    } catch {
      return null;
    }
  },
  save(t: { access_token: string; refresh_token: string; inspector: Account }) {
    localStorage.setItem(TOKEN_KEY, t.access_token);
    localStorage.setItem(REFRESH_KEY, t.refresh_token);
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(t.inspector));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
  },
};

export class AuthError extends Error {}

async function raw<T>(path: string, init?: RequestInit): Promise<T> {
  const token = auth.token();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.detail ?? body.title ?? `${res.status} ${res.statusText}`;
    if (res.status === 401 || res.status === 403) throw new AuthError(message);
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Retry once through a token refresh before giving up on the session. */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await raw<T>(path, init);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) throw e;
    try {
      const t = await raw<{ access_token: string; refresh_token: string; inspector: Account }>(
        '/v1/auth/refresh',
        { method: 'POST', body: JSON.stringify({ refresh_token: refresh }) },
      );
      auth.save(t);
      return await raw<T>(path, init);
    } catch {
      auth.clear();
      throw e;
    }
  }
}

export interface ChecklistField {
  id: string;
  section_id?: string;
  type: string;
  label: string;
  unit?: string;
  options?: { value: string; label: string }[];
}

export interface ChecklistTemplate {
  id: string;
  version: number;
  title: string;
  sections?: { id: string; title: string }[];
  fields: ChecklistField[];
}

export const api = {
  signIn: async (username: string, password: string) => {
    const t = await raw<{ access_token: string; refresh_token: string; inspector: Account }>(
      '/v1/auth/token',
      { method: 'POST', body: JSON.stringify({ username, password }) },
    );
    if (t.inspector.role !== 'supervisor') {
      throw new Error('This console is for supervisors. Inspectors use the CFPI app.');
    }
    auth.save(t);
    return t.inspector;
  },
  signOut: () => {
    auth.clear();
    location.reload();
  },

  overview: () => req<Overview>('/v1/console/overview'),
  suggestChannel: (body: { job_id: string; assigned_to: string; severity: number }) =>
    req<SuggestResponse>('/v1/console/slack/suggest', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createWorkOrder: (body: Record<string, unknown>) =>
    req<WorkOrder>('/v1/console/work-orders', { method: 'POST', body: JSON.stringify(body) }),
  updateWorkOrder: (id: string, body: Record<string, unknown>) =>
    req<WorkOrder>(`/v1/console/work-orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  template: (id: string) => req<ChecklistTemplate>(`/v1/checklist-templates/${id}`),
  job: (id: string) =>
    req<{ job: JobRecord; inspections: InspectionDetail[]; work_orders: WorkOrder[] }>(
      `/v1/console/jobs/${id}`,
    ),
  review: (inspectionId: string, decision: 'approved' | 'rejected', reason?: string) =>
    req<InspectionDetail>(`/v1/console/inspections/${inspectionId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason }),
    }),
  /** Put a drain into the inspection queue. */
  dispatch: (jobId: string, opts: { due_in_days?: number; priority?: string } = {}) =>
    req<JobRecord>(`/v1/console/jobs/${jobId}/dispatch`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /** Update the site knowledge that reaches the inspector's phone. */
  updateAsset: (jobId: string, patch: { access_notes?: string; hazards?: string[] }) =>
    req<JobRecord>(`/v1/console/jobs/${jobId}/asset`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** Take a drain back out of the queue. */
  close: (jobId: string) =>
    req<JobRecord>(`/v1/console/jobs/${jobId}/close`, { method: 'POST', body: '{}' }),
  draftFollowUp: (inspectionId: string) =>
    req<{ detail: string; channel: string }>(
      `/v1/console/inspections/${inspectionId}/draft-follow-up`,
      { method: 'POST', body: '{}' },
    ),
  draftRejection: (inspectionId: string) =>
    req<{ code: string; note: string }>(
      `/v1/console/inspections/${inspectionId}/draft-rejection`,
      { method: 'POST', body: '{}' },
    ),
  rerunAiReview: (inspectionId: string) =>
    req<AiReview | null>(`/v1/console/inspections/${inspectionId}/ai-review`, {
      method: 'POST',
      body: '{}',
    }),
  reset: () => req<{ ok: boolean }>('/v1/console/reset', { method: 'POST', body: '{}' }),
};

/**
 * Status says who holds the job, not how urgent it is. Urgency is the due date's
 * business — see `dueLabel`. Red here is reserved for a rejected inspection,
 * which genuinely is a problem with the record itself.
 */
export const STATUS_COLOUR: Record<string, string> = {
  available: '#475569',
  accepted: '#0284c7',
  in_progress: '#d97706',
  submitted: '#7c3aed',
  approved: '#16a34a',
  rejected: '#dc2626',
  cancelled: '#94a3b8',
  expired: '#b91c1c',
};

/**
 * The deadline rule is shared with the app, not reimplemented here.
 *
 * "Overdue" has to mean the same thing on a supervisor's screen and an
 * inspector's phone — the same reason the server borrows CFPI's coverage engine
 * rather than keeping its own copy.
 */
export { dueLabel, DUE_COLOUR, FLAG_WITHIN_DAYS } from '../../cfpi/src/core/due.ts';
export type { Due, DueSeverity } from '../../cfpi/src/core/due.ts';

export const STATUS_LABEL: Record<string, string> = {
  available: 'Due for inspection',
  accepted: 'Accepted',
  in_progress: 'In progress',
  submitted: 'Awaiting review',
  approved: 'Closed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/**
 * What a job's state means to the person reading it.
 *
 * A sent-back job returns to `accepted` so it stays dispatchable — correct
 * mechanically, but "Accepted" tells a supervisor nothing about why it is back
 * on someone's list. The rejection reason is what distinguishes the two.
 */
export function jobStatusLabel(job: { status: string; rejection_reason?: string | null }): string {
  if (job.status === 'accepted' && job.rejection_reason) return 'To re-inspect';
  return STATUS_LABEL[job.status] ?? job.status;
}

export function jobStatusColour(job: { status: string; rejection_reason?: string | null }): string {
  if (job.status === 'accepted' && job.rejection_reason) return STATUS_COLOUR.rejected;
  return STATUS_COLOUR[job.status] ?? '#64748b';
}
