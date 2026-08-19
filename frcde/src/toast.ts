import { useEffect, useState } from 'react';

/**
 * Transient messages, in place of `alert()`.
 *
 * The console had seven of them. A grey OS dialog dropped on top of a designed
 * page is the most jarring thing in it: it blocks the app, cannot be styled,
 * looks like a different program, and has to be dismissed before the user can
 * even look at what failed.
 *
 * Two components of the console had already replaced `prompt()` with real
 * modals and left comments explaining why. The error paths never got the same
 * treatment — this is that, finished.
 *
 * Deliberately not React context. Failures happen inside promise handlers and
 * event callbacks all over the app; making every one of them reach a provider
 * means threading a hook through code whose only involvement is that something
 * went wrong.
 */

export type ToastKind = 'error' | 'ok';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

/** Errors linger; confirmations do not need to be read twice. */
const LIFETIME_MS: Record<ToastKind, number> = { error: 7000, ok: 3500 };

let items: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

function push(kind: ToastKind, text: string): void {
  const id = nextId++;
  items = [...items, { id, kind, text }];
  emit();
  setTimeout(() => dismiss(id), LIFETIME_MS[kind]);
}

export function dismiss(id: number): void {
  const before = items.length;
  items = items.filter((t) => t.id !== id);
  if (items.length !== before) emit();
}

export const toast = {
  /** Takes the thrown value, so callers do not each write the same instanceof dance. */
  error(e: unknown, fallback = 'Something went wrong'): void {
    push('error', e instanceof Error ? e.message : typeof e === 'string' ? e : fallback);
  },
  ok(text: string): void {
    push('ok', text);
  },
};

export function useToasts(): Toast[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return items;
}
