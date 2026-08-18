/**
 * How a drain's deadline reads, and how loudly.
 *
 * Lives in `core` and is imported by both CFPI and FRCDE — the same reason the
 * coverage engine does. "Overdue" must mean one thing in the console and on the
 * handset, and two copies of a three-line rule is exactly how that stops being
 * true.
 *
 * Severity comes from the date alone. An earlier version tied the alarm colour
 * to a `priority` field stamped when a job was queued and never recalculated,
 * so a drain marked "normal" four days out stayed calm-coloured as it went
 * overdue, while the due text beside it turned red.
 */

/** A drain is flagged when it falls due inside this window. */
export const FLAG_WITHIN_DAYS = 7;

export type DueSeverity = 'overdue' | 'soon' | 'later';

export interface Due {
  text: string;
  days: number;
  overdue: boolean;
  /** Inside the flag window — worth surfacing, not yet late. */
  soon: boolean;
  /** Red is reserved for overdue. Amber warns; grey is simply information. */
  severity: DueSeverity;
}

export function dueLabel(due_at: string): Due {
  const days = Math.round((Date.parse(due_at) - Date.now()) / 86_400_000);

  if (!Number.isFinite(days)) {
    return { text: 'No due date', days: Infinity, overdue: false, soon: false, severity: 'later' };
  }
  if (days < 0) {
    return {
      text: `Overdue by ${-days}d`,
      days,
      overdue: true,
      soon: true,
      severity: 'overdue',
    };
  }
  if (days === 0) {
    return { text: 'Due today', days, overdue: false, soon: true, severity: 'soon' };
  }

  const soon = days <= FLAG_WITHIN_DAYS;
  return {
    text: `Due in ${days}d`,
    days,
    overdue: false,
    soon,
    severity: soon ? 'soon' : 'later',
  };
}

/** The single palette both apps use for deadlines. */
export const DUE_COLOUR: Record<DueSeverity, string> = {
  overdue: '#DC2626',
  soon: '#F59E0B',
  later: '#94A3B8',
};
