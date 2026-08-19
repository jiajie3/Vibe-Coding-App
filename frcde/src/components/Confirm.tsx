import type { ReactNode } from 'react';

/**
 * A confirmation the console draws itself.
 *
 * `confirm()` guarded the only irreversible action here — resetting the demo,
 * which deletes every inspection — with a dialog that gives no context beyond
 * one line and styles "OK" identically to "Cancel". A destructive action
 * deserves to say what it destroys and to make the safe choice the easy one.
 */
export default function Confirm({
  title,
  children,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal" onClick={onCancel}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2>{title}</h2>
        <div className="modal-note">{children}</div>
        <div className="btnrow">
          {/* Cancel first, and the destructive one not styled as the primary. */}
          <button className="btn" type="button" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn danger" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
