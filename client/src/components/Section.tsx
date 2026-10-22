import { useCallback, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Card } from './Card';

/**
 * A collapsible card section.
 *
 * Sections start OPEN. A booking detail that opens half-hidden makes a
 * receptionist click before they can read, and the operational cost of one
 * extra click per guest is worse than a longer page. Collapsing is there for
 * the long tail — a booking with forty timeline events — and the choice is
 * remembered per section.
 *
 * Children are unmounted while collapsed, so a closed section costs nothing to
 * render. That is the point of collapsing at all.
 */
export function Section({
  id,
  title,
  count,
  children,
  actions,
  defaultOpen = true,
  testId,
}: {
  /** Stable key for remembering the open/closed choice. */
  id: string;
  title: string;
  /** Shown beside the title, e.g. the number of rows inside. */
  count?: number;
  children: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const toggle = useCallback(() => {
    setOpen((prev) => {
      writeOpen(id, !prev);
      return !prev;
    });
  }, [id]);

  const panelId = `section-panel-${id}`;
  const headingId = `section-heading-${id}`;

  return (
    <Card className="overflow-hidden" data-testid={testId}>
      <div className="flex items-center gap-2 px-5 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          id={headingId}
          className="-mx-2 flex min-h-[2.75rem] flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`}
            aria-hidden="true"
          />
          <span>{title}</span>
          {count !== undefined ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              {count}
            </span>
          ) : null}
        </button>
        {actions}
      </div>
      {open ? (
        <div id={panelId} role="region" aria-labelledby={headingId} className="border-t border-slate-100 p-5">
          {children}
        </div>
      ) : null}
    </Card>
  );
}

const KEY = 'kas.section.open';

/**
 * Remembering the choice is a convenience, never a requirement: private mode
 * and disabled storage both throw on access, and a detail page that cannot
 * render because localStorage is unavailable would be a poor trade.
 */
function readOpen(id: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(`${KEY}.${id}`);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(`${KEY}.${id}`, open ? '1' : '0');
  } catch {
    /* Storage unavailable — the section still works for this visit. */
  }
}
