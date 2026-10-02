import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Dialog width. `lg` is the default every existing caller already had.
   *
   * `xl`/`2xl` exist for dialogs that manage a list rather than a short form —
   * room classes carry a name, a code, a toggle and a row of aliases, and at
   * `lg` each one wraps onto three lines.
   */
  /** `4xl` (896px) is for a form that needs a four-column grid, e.g. a payment. */
  size?: 'lg' | 'xl' | '2xl' | '4xl';
}

const WIDTH: Record<NonNullable<ModalProps['size']>, string> = {
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '4xl': 'max-w-4xl',
};

/** A minimal accessible modal dialog (Escape / overlay to close). */
export function Modal({ open, title, onClose, children, footer, size = 'lg' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden="true" />
      {/*
        HEADER AND FOOTER STAY PUT; THE BODY SCROLLS.

        The dialog is capped at the viewport and laid out as a column, so a long
        child list scrolls inside it instead of growing the dialog into a page
        taller than the screen — which is how the close button and the save
        actions ended up somewhere an operator had to hunt for.

        `overscroll-contain` stops the scroll chaining to the page behind once
        the list reaches its end. Short dialogs are unaffected: `max-h` only
        binds when the content would exceed it.
      */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative flex max-h-[calc(100vh-2rem)] w-full ${WIDTH[size]} flex-col rounded-2xl bg-white shadow-xl`}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-shrink-0 justify-end gap-2 border-t border-slate-200 px-5 py-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
