/**
 * "BÁO CÁO VẤN ĐỀ" — the reception operational journal.
 *
 * WHAT THIS SCREEN IS
 *
 * A clean LANDING with one action, "+ Báo cáo vấn đề", which offers the five
 * categories; then one category at a time. Each category leads with the records
 * it has produced THIS SHIFT and offers exactly one way to add to them — a
 * "+ Thêm …" dialog — with the shift-wide journal further down as a secondary,
 * collapsed-by-default cross-category view.
 *
 * LIST FIRST, FORM SECOND. The screen used to open on a payment form, so it
 * answered "what would you like to add?" before anyone had asked. What a
 * receptionist arrives wanting to know is what is already recorded; adding is
 * the second thing, and it now closes itself when it is done.
 *
 * "Sự cố vật chất đang xử lý" is a live read of the existing Technical
 * workflow. Its "+ Báo cáo sự cố" opens the SAME dialog the standalone "Báo cáo
 * sự cố" menu entry used to open — one issue form, one issue API, one issue
 * model. That menu entry is gone; this category replaced it.
 *
 * WHY THE PRIMARY TABLE AND NOT JUST THE JOURNAL
 *
 * The journal answers "what happened this shift, across every category?". It
 * does not answer "did the row I just typed look right?" — which is the
 * question somebody has while they are still at the keyboard. Making them
 * scroll a mixed chronological list to check the payment they just entered is
 * the difference between a ledger and a scratchpad.
 *
 * THE CONTEXT IS SHOWN, NEVER ASKED FOR. The banner says which branch, which
 * shift and which receptionist every record is about to be stamped with — those
 * come from the open session on the server, and there is no field anywhere on
 * this page that could change them.
 *
 * ONE ROUTE, TWO AUDIENCES. An Admin lands on the branch drill-down instead; see
 * `AdminOperationalReportsPage`. They are different screens for different
 * questions — "what am I recording now?" versus "what did that branch record?" —
 * but they share one menu entry because operators call both "Báo cáo vấn đề".
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import {
  reportsApi,
  type OperationalReport,
  type ReportCategory,
  type ReportOptions,
  type RoomServiceType,
} from '../api/receptionReports';
import { useAuth } from '../auth/AuthProvider';
import { useIsReception, useShiftSession } from '../hooks/useShiftSession';
import { PageHeader, QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { PaymentLedger } from '../components/PaymentLedger';
import { CASH_KEY, REPORTS_KEY } from '../lib/reportKeys';
import {
  GuestRequestForm,
  RoomServiceForm,
  ServiceQualityForm,
} from '../components/OperationalForms';
import { FacilityIssueBoard } from '../components/FacilityIssueBoard';
import {
  GuestRequestTable,
  RoomServiceTable,
  RoomServiceTotals,
  ServiceQualityTable,
} from '../components/OperationalTables';
import { OperationalRecordDetail } from '../components/OperationalRecord';
import { AdminOperationalReportsPage } from './AdminOperationalReportsPage';
import { formatDateTime } from '../lib/format';
import { ROOM_SERVICE_FALLBACK_LABELS, ROOM_SERVICE_ORDER } from '../lib/roomServiceFields';
import { CATEGORY_FALLBACK_LABELS, CATEGORY_ORDER } from '../lib/reportCategories';

export function OperationalReportsPage() {
  const isReception = useIsReception();
  // The Admin's question is a different one; so is their screen.
  if (!isReception) return <AdminOperationalReportsPage />;
  return <ReceptionJournal />;
}

function ReceptionJournal() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: shift } = useShiftSession();
  /*
    NULL IS THE LANDING, and it is where the screen opens: one action, "+ Báo
    cáo vấn đề", which offers the five categories. The screen used to land on a
    payment form, then on five cards — both answered a question nobody had
    asked yet. Every category then leads with WHAT IS ALREADY RECORDED rather
    than with an empty form.
  */
  const [searchParams] = useSearchParams();
  const [category, setCategory] = useState<ReportCategory | null>(() => {
    // A deep link (the old /app/issues redirects here) opens its category directly.
    const wanted = searchParams.get('category');
    return CATEGORY_ORDER.find((c) => c === wanted) ?? null;
  });
  /** The category picker, opened by "+ Báo cáo vấn đề" on the landing. */
  const [picking, setPicking] = useState(false);
  const [roomServiceType, setRoomServiceType] = useState<RoomServiceType>('ROOM_SALE');
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

  const all = list.data?.reports ?? [];
  const byCategory = (c: ReportCategory) => all.filter((r) => r.category === c);
  const tableState = {
    isLoading: sessionId !== null && list.isLoading,
    isError: list.isError,
    error: list.error,
    onRetry: () => void list.refetch(),
    canEdit: true,
  };

  return (
    <div>
      <PageHeader
        title="Báo cáo vấn đề"
        description="Ghi lại các việc phát sinh trong ca. Mỗi bản ghi tự động gắn chi nhánh, ca và tên lễ tân."
        actions={
          <button
            type="button"
            onClick={() => void list.refetch()}
            aria-label="Làm mới"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </button>
        }
      />

      {/*
        WHAT EVERY RECORD IS ABOUT TO BE STAMPED WITH — read-only, from the
        server. Compact: one line, small type, because this is context to glance
        at, not the first thing worth the eye's attention on a work screen.
      */}
      <div
        data-testid="journal-context"
        className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600"
      >
        <span className="font-medium text-slate-500">Chi nhánh</span>
        <span className="font-semibold text-slate-800">{user?.branch?.address ?? '—'}</span>
        <span className="text-slate-300">|</span>
        <span className="font-medium text-slate-500">Ca</span>
        <span className="font-semibold text-slate-800">
          {shift?.session ? `${shift.session.shiftName} · ${shift.session.shiftWindow}` : '—'}
        </span>
        <span className="text-slate-300">|</span>
        <span className="font-medium text-slate-500">Nhân viên</span>
        <span className="font-semibold text-slate-800">{shift?.session?.receptionistName ?? '—'}</span>
      </div>

      {category === null ? (
        <>
          <ReportLanding onStart={() => setPicking(true)} />
          {picking ? (
            <CategoryPicker
              label={label}
              countOf={(c) => byCategory(c).length}
              onClose={() => setPicking(false)}
              onPick={(c) => {
                setPicking(false);
                setCategory(c);
                setAdding(false);
              }}
            />
          ) : null}
        </>
      ) : (
        <CategoryShell
          title={label(category)}
          description={CATEGORY_HINTS[category]}
          addLabel={ADD_LABELS[category]}
          onAdd={() => setAdding(true)}
          onBack={() => {
            setCategory(null);
            setAdding(false);
          }}
        >

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
                    options={options.data}
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
                <Modal open title="Báo cáo vấn đề về chất lượng dịch vụ" onClose={() => setAdding(false)}>
                  <ServiceQualityForm
                    bare
                    onCancel={() => setAdding(false)}
                    onCreated={async () => {
                      await refresh();
                      setAdding(false);
                      setToast('Đã ghi nhận vấn đề về chất lượng dịch vụ.');
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
                <Modal
                  open
                  title={`Thêm ${(
                    options.data?.roomServiceTypes.find((t) => t.code === roomServiceType)?.label ??
                    ROOM_SERVICE_FALLBACK_LABELS[roomServiceType]
                  ).toLowerCase()}`}
                  onClose={() => setAdding(false)}
                >
                  <RoomServiceForm
                    bare
                    onCancel={() => setAdding(false)}
                    serviceType={roomServiceType}
                    onCreated={async () => {
                      await refresh();
                      setAdding(false);
                      setToast('Đã ghi nhận dịch vụ phòng.');
                    }}
                  />
                </Modal>
              ) : null}
              {/*
                THE SUBTYPE PICKER STAYS ON THE PAGE, not in the dialog: it
                chooses which records are being LOOKED at, and only then which
                one the dialog will add.
              */}
              <RoomServiceSubtypes
                options={options.data}
                value={roomServiceType}
                onChange={setRoomServiceType}
              />
              <RoomServiceTable
                rows={byCategory('ROOM_SERVICE').filter((r) => r.roomService?.serviceType === roomServiceType)}
                serviceType={roomServiceType}
                serviceLabel={
                  options.data?.roomServiceTypes.find((t) => t.code === roomServiceType)?.label ??
                  roomServiceType
                }
                onChanged={refresh}
                onToast={setToast}
                {...tableState}
              />
              {/*
                THE "KPI" HALF OF "Dịch vụ phòng, KPI" — arithmetic on the rows
                already on screen (count and revenue per subtype), never a fetched
                metric. This project has no KPI data source, so none is invented.
              */}
              <RoomServiceTotals
                rows={byCategory('ROOM_SERVICE')}
                order={ROOM_SERVICE_ORDER}
                labelOf={(t) => options.data?.roomServiceTypes.find((x) => x.code === t)?.label ?? t}
              />
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
 * WHICH SUBTYPE IS BEING LOOKED AT.
 *
 * This used to live inside the entry form, which meant choosing what to READ
 * required opening something to WRITE. It is a view control, so it sits with
 * the view; the dialog inherits whatever is selected here.
 */
function RoomServiceSubtypes({
  options,
  value,
  onChange,
}: {
  options?: ReportOptions;
  value: RoomServiceType;
  onChange: (t: RoomServiceType) => void;
}) {
  const labelOf = (t: RoomServiceType) =>
    options?.roomServiceTypes.find((x) => x.code === t)?.label ?? ROOM_SERVICE_FALLBACK_LABELS[t];
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="room-service-types">
      {ROOM_SERVICE_ORDER.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          aria-pressed={value === t}
          data-testid={`room-service-type-${t}`}
          className={`rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
            value === t
              ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
          }`}
        >
          {labelOf(t)}
        </button>
      ))}
    </div>
  );
}

/** What each category is for, in one line, on its own screen. */
const CATEGORY_HINTS: Record<ReportCategory, string> = {
  PAYMENT: 'Tiền đầu ca, các giao dịch trong ca và tiền cuối ca.',
  GUEST_REQUEST: 'Đồ khách ký gửi và các yêu cầu cần bàn giao cho ca sau.',
  FACILITY_ISSUE: 'Sự cố cơ sở vật chất đang chờ hoặc đang được kỹ thuật xử lý.',
  CUSTOMER_COMPLAINT: 'Phản ánh của khách về chất lượng phục vụ.',
  ROOM_SERVICE: 'Bán phòng, upgrade, hút thuốc, giặt ủi và các dịch vụ khác.',
};

const ADD_LABELS: Record<ReportCategory, string> = {
  PAYMENT: 'Thêm giao dịch',
  GUEST_REQUEST: 'Thêm vấn đề',
  // The SAME words the standalone screen used, because it is the same form.
  FACILITY_ISSUE: 'Báo cáo sự cố',
  CUSTOMER_COMPLAINT: 'Báo cáo vấn đề',
  ROOM_SERVICE: 'Thêm dịch vụ',
};

/**
 * THE LANDING — one action, nothing else asked.
 *
 * Opening "Báo cáo vấn đề" used to present five category cards straight away,
 * which is a choice nobody arriving at the screen has made yet. The landing
 * says what the screen is for and offers the one thing to do; the five
 * categories appear when that is pressed.
 */
function ReportLanding({ onStart }: { onStart: () => void }) {
  return (
    <div
      data-testid="report-landing"
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center"
    >
      <p className="text-sm text-slate-600">Ghi nhận các việc phát sinh trong ca của bạn.</p>
      <Button onClick={onStart} data-testid="report-start">
        <Plus className="h-4 w-4" aria-hidden="true" />
        Báo cáo vấn đề
      </Button>
    </div>
  );
}

/**
 * THE CATEGORY PICKER. Five peers, in a dialog, and nothing else.
 *
 * The count is this shift's own, so a receptionist can see at a glance where
 * they have already recorded something — it is a fact about the rows, never a
 * metric.
 */
function CategoryPicker({
  label,
  countOf,
  onPick,
  onClose,
}: {
  label: (c: ReportCategory) => string;
  countOf: (c: ReportCategory) => number;
  onPick: (c: ReportCategory) => void;
  onClose: () => void;
}) {
  return (
    <Modal open title="Chọn loại báo cáo" onClose={onClose}>
    <div className="grid gap-2" data-testid="category-menu">
      {CATEGORY_ORDER.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          data-testid={`category-${c}`}
          className="group flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-brand-600 hover:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          <span className="min-w-0">
            <span data-testid={`category-label-${c}`} className="block text-sm font-semibold text-slate-800">
              {label(c)}
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">{CATEGORY_HINTS[c]}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span
              data-testid={`category-count-${c}`}
              className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-slate-600"
            >
              {countOf(c)}
            </span>
            <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-brand-600" aria-hidden="true" />
          </span>
        </button>
      ))}
    </div>
    </Modal>
  );
}

/**
 * One category's screen: what is already recorded, and one way to add to it.
 *
 * The primary action lives HERE rather than inside each category's component,
 * so all five open a dialog the same way and none of them can quietly grow a
 * second entry affordance of its own.
 */
function CategoryShell({
  title,
  description,
  addLabel,
  onAdd,
  onBack,
  children,
}: {
  title: string;
  description: string;
  addLabel: string;
  onAdd: () => void;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3" data-testid="category-view">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            data-testid="category-back"
            className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Tất cả danh mục
          </button>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <p className="text-xs text-slate-500">{description}</p>
        </div>
        <Button onClick={onAdd} data-testid="category-add">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {addLabel}
        </Button>
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
