/**
 * "BÁO CÁO VẤN ĐỀ" — the reception operational journal.
 *
 * WHAT THIS SCREEN IS
 *
 * An OVERVIEW first: the shift's five categories as five compact sections, in
 * the order the categories are always listed. ONE HEADER on every screen — the
 * title, "Làm mới", and "Tổng ▾" with the open category's one primary action
 * beside it — so switching category never goes back through the overview. Each
 * category's own screen leads with the records it has produced THIS SHIFT, with
 * the shift-wide journal further down as a collapsed secondary view.
 *
 * THE OVERVIEW RE-USES EACH CATEGORY'S OWN TABLE. Nothing on it is a second
 * implementation: the payment figures are the server's drawer, the Request,
 * incident and service-quality tables are the category tables in their compact
 * form, and "Dịch vụ phòng, KPI" is reduced to its two summary figures.
 *
 * "Sự cố vật chất đang xử lý" is a live read of the existing Technical
 * workflow. Its "+ Báo cáo sự cố" opens the SAME dialog the standalone "Báo cáo
 * sự cố" menu entry used to open — one issue form, one issue API, one issue
 * model.
 *
 * THE CONTEXT IS NEVER ASKED FOR. Branch, shift and receptionist are stamped on
 * every record by the server from the open session; no field on this page can
 * change them, and the page no longer repeats them in a banner.
 *
 * ONE ROUTE, TWO AUDIENCES. An Admin lands on the branch drill-down instead; see
 * `AdminOperationalReportsPage`. They are different screens for different
 * questions — "what am I recording now?" versus "what did that branch record?" —
 * but they share one menu entry because operators call both "Báo cáo vấn đề".
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import {
  reportsApi,
  type OperationalReport,
  type ReportCategory,
  type RoomServiceType,
} from '../api/receptionReports';
import { useIsReception, useShiftSession } from '../hooks/useShiftSession';
import { QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { PaymentLedger, PaymentOverview } from '../components/PaymentLedger';
import { CASH_KEY, REPORTS_KEY } from '../lib/reportKeys';
import {
  GuestRequestForm,
  RoomServiceForm,
  ServiceQualityForm,
} from '../components/OperationalForms';
import { FacilityIssueBoard } from '../components/FacilityIssueBoard';
import {
  GuestRequestTable,
  RoomServiceOverview,
  RoomServiceTable,
  ServiceQualityTable,
} from '../components/OperationalTables';
import { OperationalRecordDetail } from '../components/OperationalRecord';
import { AdminOperationalReportsPage } from './AdminOperationalReportsPage';
import { formatDateTime } from '../lib/format';
import { ROOM_SERVICE_FALLBACK_LABELS, ROOM_SERVICE_ORDER } from '../lib/roomServiceFields';
import {
  CATEGORY_FALLBACK_LABELS,
  CATEGORY_MARKERS,
  CATEGORY_ORDER,
  RECEPTION_CATEGORY_TITLES,
} from '../lib/reportCategories';

export function OperationalReportsPage() {
  const isReception = useIsReception();
  // The Admin's question is a different one; so is their screen.
  if (!isReception) return <AdminOperationalReportsPage />;
  return <ReceptionJournal />;
}

function ReceptionJournal() {
  const queryClient = useQueryClient();
  const { data: shift } = useShiftSession();
  /*
    NULL IS THE OVERVIEW, and it is where the screen opens. A category is
    chosen from the "Tổng" menu; its screen leads with WHAT IS ALREADY RECORDED
    rather than with an empty form.
  */
  const [searchParams] = useSearchParams();
  const [category, setCategory] = useState<ReportCategory | null>(() => {
    // A deep link (the old /app/issues redirects here) opens its category directly.
    const wanted = searchParams.get('category');
    return CATEGORY_ORDER.find((c) => c === wanted) ?? null;
  });
  /** Which category's "+ Thêm" dialog is open. One at a time, by construction. */
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const options = useQuery({
    queryKey: ['reception', 'reports', 'options'],
    queryFn: () => reportsApi.options(),
    staleTime: 60 * 60 * 1000,
  });

  /*
    THE JOURNAL IS SCOPED TO THE OPEN SHIFT, and that is not a detail.

    An unfiltered read returns the branch's last 500 records across every shift
    and every day — so a category table would list last night's rows under a
    heading that reads "ca hiện tại". Disabled until the session id is known:
    without a shift there is nothing to show, and the check-in dialog is already
    covering the page.
  */
  const sessionId = shift?.session?.id ?? null;
  const list = useQuery({
    queryKey: [...REPORTS_KEY, sessionId],
    queryFn: () => reportsApi.list({ shiftSessionId: sessionId ?? undefined }),
    enabled: sessionId !== null,
    refetchOnWindowFocus: true,
  });

  const refresh = async () => {
    // Prefix match: the key carries the session id, and both must move together
    // or a table and its totals drift apart.
    await queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
    await queryClient.invalidateQueries({ queryKey: CASH_KEY });
  };

  const label = (c: ReportCategory) =>
    options.data?.categories.find((x) => x.code === c)?.label ?? CATEGORY_FALLBACK_LABELS[c];
  const title = (c: ReportCategory) => RECEPTION_CATEGORY_TITLES[c] ?? label(c);
  const roomServiceLabel = (t: RoomServiceType) =>
    options.data?.roomServiceTypes.find((x) => x.code === t)?.label ?? ROOM_SERVICE_FALLBACK_LABELS[t];

  const all = list.data?.reports ?? [];
  const byCategory = (c: ReportCategory) => all.filter((r) => r.category === c);
  const tableState = {
    isLoading: sessionId !== null && list.isLoading,
    isError: list.isError,
    error: list.error,
    onRetry: () => void list.refetch(),
    canEdit: true,
  };

  /** Straight to a category, from anywhere — never through the overview. */
  const openCategory = (c: ReportCategory) => {
    setCategory(c);
    setAdding(false);
  };
  const openOverview = () => {
    setCategory(null);
    setAdding(false);
  };

  return (
    <div>
      <ReportHeader
        category={category}
        labelOf={title}
        onPick={openCategory}
        onOverview={openOverview}
        refreshing={list.isFetching}
        onRefresh={() => void list.refetch()}
        action={category ? { label: ADD_LABELS[category], onClick: () => setAdding(true) } : null}
      />

      {category === null ? (
        <section data-testid="report-overview" aria-labelledby="report-overview-heading" className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 id="report-overview-heading" className="text-xs font-bold tracking-[0.12em] text-slate-700">
              TỔNG QUAN
            </h2>
            <span aria-hidden="true" className="h-px flex-1 bg-slate-300" />
          </div>
          <PaymentOverview title={title('PAYMENT')} section={{ marker: CATEGORY_MARKERS.PAYMENT }} />
          <GuestRequestTable
            rows={byCategory('GUEST_REQUEST')}
            title={title('GUEST_REQUEST')}
            onChanged={refresh}
            onToast={setToast}
            {...tableState}
            canEdit={false}
            compact
            section={{ marker: CATEGORY_MARKERS.GUEST_REQUEST }}
          />
          <FacilityIssueBoard
            currentShiftFacilityReports={byCategory('FACILITY_ISSUE')}
            title={title('FACILITY_ISSUE')}
            onLogged={refresh}
            onToast={setToast}
            reportOpen={false}
            onCloseReport={() => undefined}
            compact
            section={{ marker: CATEGORY_MARKERS.FACILITY_ISSUE }}
          />
          <ServiceQualityTable
            rows={byCategory('CUSTOMER_COMPLAINT')}
            title={title('CUSTOMER_COMPLAINT')}
            onChanged={refresh}
            onToast={setToast}
            {...tableState}
            canEdit={false}
            compact
            section={{ marker: CATEGORY_MARKERS.CUSTOMER_COMPLAINT }}
          />
          {/* Two figures and nothing else — the detail lives on the category's own screen. */}
          <RoomServiceOverview
            rows={byCategory('ROOM_SERVICE')}
            title={title('ROOM_SERVICE')}
            marker={CATEGORY_MARKERS.ROOM_SERVICE}
            isLoading={tableState.isLoading}
            isError={tableState.isError}
          />
        </section>
      ) : (
        <CategoryShell title={title(category)} description={CATEGORY_HINTS[category]}>
          {/*
            THE FORM AND ITS TABLE ARE OUTSIDE THE QUERY STATE for the form's sake.

            Wrapping the whole block made the page unmount whatever was being typed
            the moment the journal query started — it does, a beat after load,
            because it is keyed on the shift session id which arrives from its own
            request. A receptionist who began typing immediately watched the form
            vanish and come back empty, with a guest in front of them. The list can
            show a spinner; the box someone is typing into may not.
          */}
          {category === 'PAYMENT' ? (
            <PaymentLedger
              rows={byCategory('PAYMENT')}
              options={options.data}
              onSaved={setToast}
              addOpen={adding}
              onCloseAdd={() => setAdding(false)}
              onAdd={() => setAdding(true)}
              {...tableState}
            />
          ) : null}

          {category === 'GUEST_REQUEST' ? (
            <>
              {adding ? (
                <Modal open title="Thêm vấn đề khách yêu cầu" onClose={() => setAdding(false)}>
                  <GuestRequestForm
                    bare
                    onCancel={() => setAdding(false)}
                    onCreated={async () => {
                      await refresh();
                      setAdding(false);
                      setToast('Đã thêm yêu cầu của khách.');
                    }}
                  />
                </Modal>
              ) : null}
              <GuestRequestTable rows={byCategory('GUEST_REQUEST')} onChanged={refresh} onToast={setToast} {...tableState} />
            </>
          ) : null}

          {category === 'FACILITY_ISSUE' ? (
            <FacilityIssueBoard
              currentShiftFacilityReports={byCategory('FACILITY_ISSUE')}
              onLogged={refresh}
              onToast={setToast}
              reportOpen={adding}
              onCloseReport={() => setAdding(false)}
            />
          ) : null}

          {category === 'CUSTOMER_COMPLAINT' ? (
            <>
              {adding ? (
                <Modal open title="Báo cáo vấn đề về chất lượng và dịch vụ" onClose={() => setAdding(false)}>
                  <ServiceQualityForm
                    bare
                    onCancel={() => setAdding(false)}
                    onCreated={async () => {
                      await refresh();
                      setAdding(false);
                      setToast('Đã ghi nhận vấn đề về chất lượng và dịch vụ.');
                    }}
                  />
                </Modal>
              ) : null}
              <ServiceQualityTable rows={byCategory('CUSTOMER_COMPLAINT')} onChanged={refresh} onToast={setToast} {...tableState} />
            </>
          ) : null}

          {category === 'ROOM_SERVICE' ? (
            <>
              {adding ? (
                <Modal open title="Thêm dịch vụ" onClose={() => setAdding(false)}>
                  <RoomServiceForm
                    bare
                    options={options.data}
                    onCancel={() => setAdding(false)}
                    onCreated={async () => {
                      await refresh();
                      setAdding(false);
                      setToast('Đã ghi nhận dịch vụ phòng.');
                    }}
                  />
                </Modal>
              ) : null}
              {/*
                FIVE SECTIONS, ONE PER SERVICE, stacked — not five tabs. Each holds
                only its own service's rows; the columns follow the service.
              */}
              <div className="space-y-4" data-testid="room-service-groups">
                {ROOM_SERVICE_ORDER.map((type) => (
                  <RoomServiceTable
                    key={type}
                    rows={byCategory('ROOM_SERVICE').filter((r) => r.roomService?.serviceType === type)}
                    serviceType={type}
                    serviceLabel={roomServiceLabel(type)}
                    onChanged={refresh}
                    onToast={setToast}
                    {...tableState}
                    compact
                    section={{}}
                  />
                ))}
              </div>
            </>
          ) : null}

          {/*
            THE SHIFT JOURNAL — secondary, cross-category, collapsed by default.

            The category table above is the primary presentation; this remains
            for "what did I enter this shift, in order, regardless of
            category?", which is a real question at handover time but not the
            one being asked while looking at one category.
          */}
          <SecondaryJournal
            rows={all}
            isLoading={tableState.isLoading}
            isError={tableState.isError}
            error={tableState.error}
            onRetry={tableState.onRetry}
          />
        </CategoryShell>
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/**
 * THE REPORT HEADER — one component for the overview and all five categories,
 * so they cannot drift into five slightly different headers.
 *
 *   Theo dõi tình hình các vấn đề, thanh toán trong ca làm việc
 *                                                     [ Làm mới ]
 *   [ Tổng ▾ ]                                 [ + context action ]
 *
 * "Tổng" stays on every screen, so switching categories never goes back through
 * the overview. Only three things vary: which category is open, and the label
 * and handler of its one primary action (none on the overview).
 */
function ReportHeader({
  category,
  labelOf,
  onPick,
  onOverview,
  refreshing,
  onRefresh,
  action,
}: {
  category: ReportCategory | null;
  labelOf: (c: ReportCategory) => string;
  onPick: (c: ReportCategory) => void;
  onOverview: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  action: { label: string; onClick: () => void } | null;
}) {
  return (
    <div className="mb-5" data-testid="report-header">
      <h1 className="text-xl font-bold leading-snug tracking-tight text-slate-900">
        Theo dõi tình hình các vấn đề, thanh toán trong ca làm việc
      </h1>
      <div className="mt-3 flex justify-end" data-testid="report-header-refresh-row">
        <Button variant="secondary" onClick={onRefresh} aria-label="Làm mới" className="shadow-sm">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          Làm mới
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="report-header-nav-row">
        <TotalMenu current={category} labelOf={labelOf} onPick={onPick} onOverview={onOverview} />
        {action ? (
          <Button onClick={action.onClick} data-testid="category-add" className="shadow-sm">
            <Plus className="h-4 w-4" aria-hidden="true" />
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "TỔNG ▾" — the category switcher, on every screen.
 *
 * A menu button in the WAI-ARIA sense: the arrow keys move between the five
 * items, Escape closes it and returns focus to the button, and a click outside
 * closes it. The five items are the five categories, in their fixed order, and
 * nothing else; the open one is marked.
 *
 * ON A CATEGORY'S SCREEN IT IS A SPLIT BUTTON: "Tổng" goes back to the
 * overview — the only way back, now that there is no "Tất cả danh mục" link —
 * and the caret opens the menu. On the overview there is nowhere to go back
 * to, so the whole control opens the menu.
 */
function TotalMenu({
  current,
  labelOf,
  onPick,
  onOverview,
}: {
  current: ReportCategory | null;
  labelOf: (c: ReportCategory) => string;
  onPick: (c: ReportCategory) => void;
  onOverview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    // Focus the open category, or the first one.
    const index = current ? CATEGORY_ORDER.indexOf(current) : 0;
    itemRefs.current[index >= 0 ? index : 0]?.focus();
  }, [open, current]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    const index = items.findIndex((el) => el === document.activeElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const segment =
    'flex h-10 items-center bg-brand-600 text-sm font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2';
  const caret = (
    <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2.5} aria-hidden="true" />
  );
  const menuButtonProps = {
    ref: buttonRef,
    type: 'button' as const,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? 'report-total-menu' : undefined,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' && !open) {
        e.preventDefault();
        setOpen(true);
      }
    },
    'data-testid': 'report-total',
  };

  return (
    <div className="relative">
      {current === null ? (
        <button {...menuButtonProps} className={`${segment} gap-0 rounded-xl shadow-sm`}>
          <span className="px-4">Tổng</span>
          <span className="flex h-full items-center border-l border-white/30 px-2.5">{caret}</span>
        </button>
      ) : (
        <div className="inline-flex rounded-xl shadow-sm">
          <button
            type="button"
            onClick={onOverview}
            aria-label="Tổng — về tổng quan"
            data-testid="report-total-overview"
            className={`${segment} rounded-l-xl px-4`}
          >
            Tổng
          </button>
          <button
            {...menuButtonProps}
            aria-label="Chọn danh mục"
            className={`${segment} rounded-r-xl border-l border-white/30 px-2.5`}
          >
            {caret}
          </button>
        </div>
      )}

      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            id="report-total-menu"
            role="menu"
            aria-label="Danh mục báo cáo"
            data-testid="category-menu"
            onKeyDown={onMenuKeyDown}
            className="absolute left-0 z-20 mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-300 bg-white p-1 shadow-lg"
          >
            <p role="presentation" className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Xem chi tiết danh mục
            </p>
            {CATEGORY_ORDER.map((c, i) => {
              const active = current === c;
              return (
                <button
                  key={c}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    setOpen(false);
                    onPick(c);
                  }}
                  data-testid={`category-${c}`}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-brand-50 hover:text-brand-800 focus:bg-brand-50 focus:text-brand-800 focus:outline-none ${
                    active ? 'bg-brand-50 font-semibold text-brand-800' : 'font-medium text-slate-700'
                  }`}
                >
                  <span>{labelOf(c)}</span>
                  {active ? <Check className="h-4 w-4 shrink-0 text-brand-700" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** What each category is for, in one line, on its own screen. */
const CATEGORY_HINTS: Record<ReportCategory, string> = {
  PAYMENT: 'Tiền đầu ca, các giao dịch trong ca và tiền cuối ca.',
  GUEST_REQUEST: 'Yêu cầu của khách cần thực hiện hoặc bàn giao cho ca sau.',
  FACILITY_ISSUE: 'Sự cố cơ sở vật chất đang chờ hoặc đang được kỹ thuật xử lý.',
  CUSTOMER_COMPLAINT: 'Phản ánh của khách về chất lượng và dịch vụ.',
  ROOM_SERVICE: 'Bán phòng, upgrade, hút thuốc, giặt ủi và các dịch vụ khác.',
};

/** The one primary action of each category, in the header's lower-right. */
const ADD_LABELS: Record<ReportCategory, string> = {
  PAYMENT: 'Thêm giao dịch',
  GUEST_REQUEST: 'Thêm vấn đề',
  // The SAME words the standalone screen used, because it is the same form.
  FACILITY_ISSUE: 'Báo cáo sự cố',
  CUSTOMER_COMPLAINT: 'Báo cáo vấn đề',
  ROOM_SERVICE: 'Thêm dịch vụ',
};

/**
 * One category's screen: its name, one line on what it is for, and what is
 * already recorded. The way in and the way to add both live in the header.
 */
function CategoryShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3" data-testid="category-view">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-500">{description}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * "NHẬT KÝ CA HIỆN TẠI" — demoted, not deleted.
 *
 * A native `<details>` disclosure: closed by default, so the page reads as
 * FORM → PRIMARY TABLE → (optional journal) rather than FORM → tiny journal.
 * Muted typography throughout, so opening it never competes for attention with
 * the category table above.
 */
function SecondaryJournal({
  rows,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  rows: OperationalReport[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <details
      data-testid="journal-section"
      className="group rounded-lg border border-slate-200 bg-slate-50/60 open:bg-white"
    >
      <summary
        data-testid="journal-toggle"
        className="cursor-pointer select-none list-none px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-700"
      >
        <span className="inline-flex items-center gap-1.5">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:hidden" aria-hidden="true" />
          <ChevronDown className="hidden h-3.5 w-3.5 group-open:block" aria-hidden="true" />
          Nhật ký ca hiện tại
          <span className="font-normal text-slate-400">({rows.length})</span>
        </span>
      </summary>

      <div className="border-t border-slate-200 px-1 pb-1">
        <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={onRetry}>
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-sm text-slate-400">Chưa có bản ghi nào trong ca này.</p>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="journal-list">
              {rows.map((row) => {
                const open = openId === row.id;
                return (
                  <li key={row.id} className={row.voided ? 'bg-slate-50/80' : ''}>
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : row.id)}
                      data-testid={`journal-row-${row.id}`}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50"
                    >
                      {open ? (
                        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-slate-400">
                          <span>{formatDateTime(row.createdAt)}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-slate-600">{row.categoryLabel}</span>
                          <span aria-hidden="true">·</span>
                          <span>{row.createdByName}</span>
                          {row.voided ? (
                            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
                              Đã hủy
                            </span>
                          ) : null}
                        </span>
                        <span
                          className={`block truncate text-sm ${row.voided ? 'text-slate-400 line-through' : 'text-slate-700'}`}
                        >
                          {row.summary}
                        </span>
                      </span>
                    </button>

                    {open ? (
                      <div className="border-t border-slate-100 bg-slate-50/50 px-3 py-2.5">
                        <OperationalRecordDetail row={row} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </QueryState>
      </div>
    </details>
  );
}
