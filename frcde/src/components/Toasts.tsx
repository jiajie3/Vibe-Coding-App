import { dismiss, useToasts } from '../toast.ts';

/**
 * Where transient messages appear.
 *
 * Bottom-left, not top-right. The console's own actions live at the top of each
 * panel, and a message that covers the button you just pressed hides the thing
 * you are trying to understand.
 *
 * `role="status"` with `aria-live="polite"` so a screen reader announces it
 * without interrupting — which is the behaviour `alert()` got for free, and the
 * part that is easy to lose when replacing it.
 */
export default function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
