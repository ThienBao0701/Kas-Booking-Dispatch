/**
 * "THEO DÕI THANH TOÁN" — the front-desk cash ledger.
 *
 * LAYOUT, TOP TO BOTTOM
 *
 *   SUMMARY STRIP     tiền đầu ca (editable), số giao dịch, thu tiền mặt, chi,
 *                     và tiền cuối ca nổi bật — the drawer's figures only
 *   DANH SÁCH GIAO DỊCH TRONG CA   every transaction this shift, immediately:
 *                     Tên khách, Mã EZ, Nguồn, Tiền mặt, Cà thẻ, Công nợ, Chi
 *
 * The entry form is NOT on the page: "+ Thêm giao dịch" in the category header
 * opens it in a dialog, and it closes itself on save. A permanent form pushed
 * both the drawer and the shift's own transactions below the fold — the screen
 * asked "what would you like to add?" when a cashier arrives asking "what is in
 * the drawer, and what have I taken?".
 *
 * THE TOTALS ARE THE SERVER'S.
 *
 * "Tiền cuối ca" is not computed here, and there is no field to type one into.
 * It comes back from `/reception/shifts/cash` after every change, so the figure
 * on screen is the same arithmetic the PDF and the Admin report use — TIỀN CUỐI
 * CA = TIỀN ĐẦU CA + THU TIỀN MẶT − CHI TIỀN MẶT, computed exactly once, on the
 * server. Adding the numbers up in React would be a second implementation of
 * that formula, and the two would disagree on precisely the shift where
 * somebody had to explain a discrepancy.
 *
 * EDITING A ROW STAYS IN THE ROW, deliberately, unlike the other categories'
 * modal dialogs: a cashier correcting a figure is looking at the column it sits
 * in, and the surrounding rows are the context that makes the correction obvious
 * at a glance.
 *
 * "XÓA" DOES NOT DELETE. It asks for a reason and voids the row: the money
 * stops counting and the record stays, marked, with who withdrew it and why. A
 * financial row that can be made to vanish makes the drawer unexplainable.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  reportsApi,
  type CashSummary,
  type OperationalReport,
  type PaymentMethod,
  type ReportOptions,
} from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { Input } from './Input';
import { ErrorAlert } from './ErrorAlert';
import { MoneyInput } from './MoneyInput';
import { Modal } from './Modal';
import { VoidDialog } from './RecordDialogs';
import { DataTable, type DataColumn } from './DataTable';
import type { SectionFrame } from './ReportSection';
import { formatVnd, groupDigits, parseVnd, parseVndOrZero } from '../lib/money';
import { CASH_KEY, REPORTS_KEY } from '../lib/reportKeys';
import { PAYMENT_SOURCE_FALLBACK } from '../lib/reportCategories';
import { useShiftCash } from '../hooks/useShiftCash';

const METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'CARD'];

interface Props {
  rows: OperationalReport[];
  options?: ReportOptions;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onSaved: (message: string) => void;
  /**
   * The entry form lives in a dialog the category header opens, not on the page.
   *
   * A permanent form pushed the drawer figures and the shift's transactions
   * below the fold, so the screen answered "what would you like to add?" when
   * the question a cashier arrives with is "what is in the drawer and what have
   * I taken?". The form is one click away and closes itself on save.
   */
  addOpen: boolean;
  onCloseAdd: () => void;
  /** Opens the same dialog — offered again inside an empty ledger. */
  onAdd?: () => void;
}

export function PaymentLedger({
  rows,
  options,
  isLoading,
  isError,
  error,
  onRetry,
  onSaved,
  addOpen,
  onCloseAdd,
  onAdd,
}: Props) {
  const queryClient = useQueryClient();
  const cash = useShiftCash();
  const sources = options?.paymentSources ?? PAYMENT_SOURCE_FALLBACK;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
    await queryClient.invalidateQueries({ queryKey: CASH_KEY });
  };

  return (
    <div className="space-y-3">
      <PaymentSummaryStrip
        summary={cash.data?.cash ?? null}
        loading={cash.isLoading}
        onOpeningSaved={async () => {
          await refresh();
          onSaved('Đã lưu tiền đầu ca.');
        }}
      />
      {addOpen ? (
        <Modal open size="4xl" title="Thêm giao dịch" onClose={onCloseAdd}>
          <NewPaymentForm
            bare
            onCancel={onCloseAdd}
            methods={options?.paymentMethods}
            sources={sources}
            onCreated={async () => {
              await refresh();
              onCloseAdd();
              onSaved('Đã thêm giao dịch.');
            }}
          />
        </Modal>
      ) : null}
      <PaymentTable
        rows={rows}
        sources={sources}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        onChanged={refresh}
        onSaved={onSaved}
        onAdd={onAdd}
      />
    </div>
  );
}

/* ------------------------------ Overview table ------------------------------ */

/**
 * The drawer in four figures, for the report overview.
 *
 * The same `/reception/shifts/cash` answer the ledger's strip shows, so the two
 * cannot disagree about "Tiền mặt cuối ca" — which, like everything here, is the
 * server's arithmetic and never recomputed in React. Entering "Tiền đầu ca"
 * stays in the ledger; here an uncounted drawer simply reads "Chưa nhập".
 */
export function PaymentOverview({ title, section }: { title: string; section?: SectionFrame }) {
  const cash = useShiftCash();
  const summary = cash.data?.cash ?? null;
  const pending = (text: string) => <span className="text-sm font-normal text-slate-400">{text}</span>;
  // The amount never breaks; the header may, so four columns fit a phone.
  const amount = (value: number, strong = false) => (
    <span
      className={`whitespace-nowrap ${
        strong ? 'text-[15px] font-bold sm:text-base' : 'text-sm font-semibold text-slate-900 sm:text-[15px]'
      }`}
    >
      {formatVnd(value)}
    </span>
  );
  /*
    FOUR MONEY COLUMNS ON A PHONE. Two seven-digit amounts leave the other two
    columns so narrow that "Tiền mặt thu trong ca" broke over four lines; a
    little less padding and a slightly smaller figure below `sm`, plus a floor
    under that one column, keep every header to two balanced lines. `!` because
    the table sets the desktop padding itself.
  */
  const cell = 'tabular-nums text-balance !px-2 sm:!px-3';

  const columns: DataColumn<CashSummary>[] = [
    {
      key: 'opening',
      header: 'Tiền đầu ca',
      align: 'right',
      className: cell,
      render: (s) => (s.openingCash === null ? pending('Chưa nhập') : amount(s.openingCash)),
    },
    {
      key: 'cashCollected',
      header: 'Tiền mặt thu trong ca',
      align: 'right',
      className: `${cell} min-w-[6.25rem]`,
      render: (s) => amount(s.cashCollected),
    },
    {
      key: 'cashExpense',
      header: 'Chi',
      align: 'right',
      className: cell,
      render: (s) => amount(s.cashExpense),
    },
    /*
      THE RESULT, set apart as a tinted column — header and figure together — so
      the drawer's answer is found first without becoming a banner.
    */
    {
      key: 'endingCash',
      header: 'Tiền mặt cuối ca',
      align: 'right',
      className: `${cell} bg-brand-50 text-brand-800`,
      render: (s) => (s.endingCash === null ? pending('Chưa xác định') : amount(s.endingCash, true)),
    },
  ];

  return (
    <DataTable
      testId="payment-overview"
      title={title}
      columns={columns}
      rows={summary ? [summary] : []}
      rowKey={() => 'drawer'}
      isLoading={cash.isLoading}
      isError={cash.isError}
      error={cash.error}
      onRetry={() => void cash.refetch()}
      compact
      section={section}
      emptyTitle="Chưa có số liệu tiền mặt của ca."
      emptyMessage=""
    />
  );
}

/* ------------------------------ Summary strip ------------------------------ */

/**
 * ONE ROW: [Tiền đầu ca] [Số giao dịch] [Thu tiền mặt] [Chi] [Tiền cuối ca].
 *
 * THE DRAWER'S FIGURES ONLY. Transfer, card and receivable totals are real, and
 * the Admin's report shows them, but none of them moves the cash a receptionist
 * counts at handover — so the desk's strip leaves them out rather than setting
 * four numbers beside the one that must balance. The ending-cash arithmetic is
 * the server's and does not change with what is displayed.
 *
 * Every figure but the first is read-only, from the server. "Tiền đầu ca" is
 * the one count a receptionist makes by hand, so it alone gets an edit
 * affordance — inline, in its own cell, so correcting it never leaves this
 * strip or opens something that looks like a form.
 */
function PaymentSummaryStrip({
  summary,
  loading,
  onOpeningSaved,
}: {
  summary: CashSummary | null;
  loading: boolean;
  onOpeningSaved: () => void | Promise<void>;
}) {
  // Owned here, not in the cell, so the reminder below can open the same editor.
  const [editingOpening, setEditingOpening] = useState(false);

  if (loading && !summary) {
    return (
      <div
        data-testid="cash-summary-loading"
        className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Đang tải số dư ca…
      </div>
    );
  }
  if (!summary) return null;

  const chips: { label: string; value: string; testId?: string }[] = [
    { label: 'Số giao dịch', value: String(summary.paymentCount) },
    { label: 'Thu tiền mặt', value: formatVnd(summary.cashCollected) },
    { label: 'Chi', value: formatVnd(summary.cashExpense) },
  ];

  return (
    <>
      {/*
        A REMINDER, NOT A GATE. The page stays usable — the receptionist can read
        the ledger and record payments — because a counted drawer entered late is
        better than a receptionist blocked from working. Until it is entered,
        "Tiền cuối ca" reads "Chưa xác định", so nothing pretends to a balance.
      */}
      {summary.openingCash === null && !editingOpening ? (
        <div
          role="status"
          data-testid="opening-cash-warning"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-900">Chưa nhập tiền đầu ca</p>
            <p className="text-xs text-amber-800">Tiền đầu ca chưa được thiết lập cho ca hiện tại.</p>
          </div>
          <Button variant="secondary" onClick={() => setEditingOpening(true)} data-testid="opening-cash-warning-enter">
            Nhập tiền đầu ca
          </Button>
        </div>
      ) : null}
      <div data-testid="cash-summary-strip" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-5">
          <OpeningCashCell
            openingCash={summary.openingCash}
            editing={editingOpening}
            onEdit={() => setEditingOpening(true)}
            onCancel={() => setEditingOpening(false)}
            onSaved={async () => {
              setEditingOpening(false);
              await onOpeningSaved();
            }}
          />
          {chips.map((c) => (
            <div key={c.label} className="bg-white px-3 py-2.5" data-testid={c.testId}>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">{c.label}</p>
              <p className="text-sm font-semibold tabular-nums text-slate-800">{c.value}</p>
            </div>
          ))}
          {/* TIỀN CUỐI CA — the headline figure, set apart by weight and colour. */}
          <div className="col-span-2 bg-brand-50 px-3 py-2.5 sm:col-span-1">
            <p className="text-[11px] uppercase tracking-wide text-brand-700">Tiền cuối ca</p>
            <p className="text-base font-bold tabular-nums text-brand-800" data-testid="ending-cash">
              {summary.endingCash === null ? 'Chưa xác định' : formatVnd(summary.endingCash)}
            </p>
          </div>
        </div>
        <p className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400">
          Tiền cuối ca = Tiền đầu ca + Thu tiền mặt − Chi tiền mặt. Chuyển khoản và cà thẻ không làm
          thay đổi tiền mặt.
          {summary.voidedCount > 0 ? (
            <span className="ml-1 text-rose-500" data-testid="voided-note">
              {summary.voidedCount} bản ghi đã hủy, không tính vào tổng.
            </span>
          ) : null}
        </p>
      </div>
    </>
  );
}

/** The "Tiền đầu ca" cell: the figure, and the way into its editor. */
function OpeningCashCell({
  openingCash,
  editing,
  onEdit,
  onCancel,
  onSaved,
}: {
  openingCash: number | null;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  if (!editing) {
    return (
      <button
        type="button"
        onClick={onEdit}
        data-testid="opening-cash-edit"
        className="group bg-white px-3 py-2.5 text-left hover:bg-slate-50"
      >
        <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-400">
          Tiền đầu ca
          <Pencil className="h-2.5 w-2.5 text-slate-300 group-hover:text-slate-500" aria-hidden="true" />
        </p>
        <p className="text-sm font-semibold tabular-nums text-slate-800" data-testid="opening-cash-value">
          {openingCash === null ? 'Chưa kiểm đếm' : formatVnd(openingCash)}
        </p>
      </button>
    );
  }
  // Mounted fresh each time it opens, so it starts from the current figure.
  return <OpeningCashEditor openingCash={openingCash} onCancel={onCancel} onSaved={onSaved} />;
}

function OpeningCashEditor({
  openingCash,
  onCancel,
  onSaved,
}: {
  openingCash: number | null;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [value, setValue] = useState(openingCash === null ? '' : groupDigits(String(openingCash)));
  const [error, setError] = useState<string | null>(null);

  // Empty is "chưa kiểm đếm", never a counted zero — see `setOpeningCash`.
  const counted = parseVnd(value);

  const save = useMutation({
    mutationFn: () => reportsApi.setOpeningCash(counted ?? 0),
    onSuccess: async () => {
      setError(null);
      await onSaved();
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  return (
    <div className="col-span-2 space-y-1.5 bg-slate-50 px-3 py-2.5">
      <div className="flex items-end gap-1.5">
        <div className="flex-1">
          <MoneyInput label="Tiền đầu ca" value={value} onChange={setValue} data-testid="opening-cash-input" />
        </div>
        <Button
          onClick={() => save.mutate()}
          disabled={counted === null}
          loading={save.isPending}
          data-testid="opening-cash-save"
        >
          Lưu
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Hủy
        </Button>
      </div>
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
    </div>
  );
}

/* --------------------------- Thêm giao dịch --------------------------- */

const EMPTY_FORM = {
  ezCode: '',
  source: '',
  guestName: '',
  method: 'CASH' as PaymentMethod,
  amount: '',
  receivable: '',
  expense: '',
};

const selectClass =
  'block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-600';

/**
 * "NGUỒN" IS A SELECT, NOT A TEXT BOX — the five channels the server accepts
 * (`/reception/reports/options`), or none for a walk-in. Free text is how one
 * channel became three spellings in a report.
 */
function SourceSelect({
  id,
  value,
  onChange,
  sources,
  className = selectClass,
  testId,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  sources: string[];
  className?: string;
  testId: string;
}) {
  // An older row may carry a source typed before the list was closed. It is
  // offered as-is so a correction does not silently rewrite it.
  const legacy = value && !sources.includes(value) ? value : null;
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} className={className}>
      <option value="">— Chọn nguồn —</option>
      {sources.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
      {legacy ? <option value={legacy}>{legacy} (dữ liệu cũ)</option> : null}
    </select>
  );
}

function NewPaymentForm({
  methods,
  sources,
  onCreated,
  onCancel,
  bare,
}: {
  methods?: ReportOptions['paymentMethods'];
  sources: string[];
  onCreated: () => void | Promise<void>;
  onCancel?: () => void;
  bare?: boolean;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const create = useMutation({
    mutationFn: () =>
      reportsApi.create({
        category: 'PAYMENT',
        payment: {
          ezCode: form.ezCode.trim() || undefined,
          source: form.source || undefined,
          guestName: form.guestName.trim() || undefined,
          method: form.method,
          // Parsed at the boundary: the grouped display never leaves the field.
          amount: parseVnd(form.amount) ?? 0,
          receivable: parseVndOrZero(form.receivable),
          expense: parseVndOrZero(form.expense),
        },
      }),
    onSuccess: async () => {
      setError(null);
      setForm(EMPTY_FORM);
      await onCreated();
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  const ready = parseVnd(form.amount) !== null;

  return (
    <form
      data-testid="payment-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) create.mutate();
      }}
      className={bare ? 'space-y-2.5' : 'space-y-2.5 rounded-xl border border-slate-200 bg-white px-4 py-3'}
    >
      {bare ? null : <p className="text-sm font-semibold text-slate-800">Thêm giao dịch</p>}

      {/*
        TWO ROWS: the booking, then the money. Mã EZ, Nguồn and Tên khách; then
        Phương thức, Số tiền, Công nợ and Chi tiền. No room and no note — the
        booking reference finds the room, and a note is not something the desk
        needs at the till.

        "NHÂN VIÊN" IS NOT A FIELD. It is whoever is on the open shift, decided by
        the server — so it is shown, not asked for.

        NO HELPER TEXT UNDER THE MONEY FIELDS. Which figures move the drawer is a
        rule the server applies (and the tests pin), not a sentence to re-read on
        every transaction — and the hints were what made the fields unequal.
      */}
      <div className="grid gap-3 sm:grid-cols-3" data-testid="payment-row-who">
        <Input label="Mã EZ" value={form.ezCode} onChange={(e) => set('ezCode', e.target.value)} data-testid="payment-ez" />
        <div className="space-y-1.5">
          <label htmlFor="payment-source" className="block text-sm font-medium text-slate-700">
            Nguồn
          </label>
          <SourceSelect
            id="payment-source"
            value={form.source}
            onChange={(v) => set('source', v)}
            sources={sources}
            testId="payment-source"
          />
        </div>
        <Input label="Tên khách" value={form.guestName} onChange={(e) => set('guestName', e.target.value)} data-testid="payment-guest" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4" data-testid="payment-row-money">
        <div className="space-y-1.5">
          <label htmlFor="payment-method" className="block whitespace-nowrap text-sm font-medium text-slate-700">
            Phương thức thanh toán
          </label>
          <select
            id="payment-method"
            value={form.method}
            onChange={(e) => set('method', e.target.value as PaymentMethod)}
            data-testid="payment-method"
            className={selectClass}
          >
            {(methods ?? METHODS.map((code) => ({ code, label: code }))).map((m) => (
              <option key={m.code} value={m.code}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <MoneyInput
          label="Số tiền"
          required
          value={form.amount}
          onChange={(v) => set('amount', v)}
          data-testid="payment-amount"
        />
        <MoneyInput
          label="Công nợ"
          value={form.receivable}
          onChange={(v) => set('receivable', v)}
          data-testid="payment-receivable"
        />
        <MoneyInput
          label="Chi tiền"
          value={form.expense}
          onChange={(v) => set('expense', v)}
          data-testid="payment-expense"
        />
      </div>

      {error ? <ErrorAlert>{error}</ErrorAlert> : null}

      <div className={`flex justify-end gap-2 ${bare ? 'border-t border-slate-100 pt-3' : ''}`}>
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel} data-testid="payment-cancel">
            Hủy
          </Button>
        ) : null}
        <Button type="submit" disabled={!ready} loading={create.isPending} data-testid="payment-add">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Thêm
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------- The table ------------------------------- */

function PaymentTable({
  rows,
  sources,
  isLoading,
  isError,
  error,
  onRetry,
  onChanged,
  onSaved,
  onAdd,
}: {
  rows: OperationalReport[];
  sources: string[];
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onChanged: () => Promise<void>;
  onSaved: (message: string) => void;
  onAdd?: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  return (
    <section data-testid="payment-table-section" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50/70 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-slate-800">
          Danh sách giao dịch trong ca
          <span className="ml-2 rounded bg-slate-200/80 px-1.5 py-0.5 text-xs font-medium tabular-nums text-slate-600">
            {rows.length}
          </span>
        </h3>
      </header>

      {isLoading ? (
        <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Đang tải…
        </p>
      ) : isError ? (
        <div className="px-4 py-6">
          <ErrorAlert>{toUserMessage(error)}</ErrorAlert>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex min-h-[2.5rem] items-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Thử lại
            </button>
          ) : null}
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="payment-empty" className="px-4 py-8 text-center">
          <p className="text-sm font-medium text-slate-700">Chưa có giao dịch nào trong ca này</p>
          <p className="mt-1 text-sm text-slate-500">Giao dịch sẽ hiện ngay tại đây sau khi được thêm.</p>
          {onAdd ? (
            <Button className="mt-3" onClick={onAdd} data-testid="payment-empty-add">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Thêm giao dịch
            </Button>
          ) : null}
        </div>
      ) : (
        // One table, scrolled horizontally on a narrow screen rather than
        // collapsed into cards: the value of this view is comparing rows at a
        // glance, and a stack of cards loses exactly that.
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="payment-table">
            {/*
              EIGHT COLUMNS AND ONE COMPACT "THAO TÁC". Staff, room, transfer and
              note are not the desk's questions at the till: the shift says who,
              the booking says where, and a transfer never reaches the drawer.
              The Admin's table keeps all of them.
            */}
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">STT</th>
                <th className="px-3 py-2 text-left font-medium">Tên khách</th>
                <th className="px-3 py-2 text-left font-medium">Mã EZ</th>
                <th className="px-3 py-2 text-left font-medium">Nguồn</th>
                <th className="px-3 py-2 text-right font-medium">Tiền mặt</th>
                <th className="px-3 py-2 text-right font-medium">Cà thẻ</th>
                <th className="px-3 py-2 text-right font-medium">Công nợ</th>
                <th className="px-3 py-2 text-right font-medium">Chi</th>
                <th className="w-[1%] whitespace-nowrap px-3 py-2 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, index) =>
                editingId === row.id ? (
                  <EditRow
                    key={row.id}
                    row={row}
                    index={index}
                    sources={sources}
                    onCancel={() => setEditingId(null)}
                    onSaved={async () => {
                      setEditingId(null);
                      await onChanged();
                      onSaved('Đã lưu chỉnh sửa.');
                    }}
                  />
                ) : (
                  <ReadRow
                    key={row.id}
                    row={row}
                    index={index}
                    onEdit={() => setEditingId(row.id)}
                    onVoid={() => setVoidingId(row.id)}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {voidingId ? (
        <VoidDialog
          id={voidingId}
          onClose={() => setVoidingId(null)}
          onVoided={async () => {
            setVoidingId(null);
            await onChanged();
            onSaved('Đã hủy giao dịch. Bản ghi vẫn được lưu lại.');
          }}
        />
      ) : null}
    </section>
  );
}

function ReadRow({
  row,
  index,
  onEdit,
  onVoid,
}: {
  row: OperationalReport;
  index: number;
  onEdit: () => void;
  onVoid: () => void;
}) {
  const p = row.payment!;
  return (
    <tr
      data-testid={`payment-row-${row.id}`}
      className={`transition-colors hover:bg-slate-50 ${row.voided ? 'bg-slate-50 text-slate-400 line-through' : ''}`}
    >
      <td className="px-3 py-2.5 align-top text-slate-400">{index + 1}</td>
      <td className="min-w-[7rem] px-3 py-2.5 align-top">
        {p.guestName ?? '—'}
        {row.voided ? (
          <span className="mt-0.5 block text-xs font-medium text-rose-600 no-underline">
            Đã hủy: {row.voidReason}
          </span>
        ) : null}
        {row.audits.some((a) => a.action === 'EDIT') ? (
          <span className="mt-0.5 block text-xs text-amber-700 no-underline" data-testid={`payment-edited-${row.id}`}>
            Đã sửa
          </span>
        ) : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 align-top">{p.ezCode ?? '—'}</td>
      <td className="whitespace-nowrap px-3 py-2.5 align-top">{p.source ?? '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums whitespace-nowrap">{p.cash ? formatVnd(p.cash) : '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums whitespace-nowrap">{p.card ? formatVnd(p.card) : '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums whitespace-nowrap">{p.receivable ? formatVnd(p.receivable) : '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums whitespace-nowrap">{p.expense ? formatVnd(p.expense) : '—'}</td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">
        {row.voided ? (
          <span className="text-xs text-slate-300">—</span>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              data-testid={`payment-edit-${row.id}`}
              className="ml-1 inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />
              Sửa
            </button>
            <button
              type="button"
              onClick={onVoid}
              data-testid={`payment-void-${row.id}`}
              className="ml-1 inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Xóa
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

function EditRow({
  row,
  index,
  sources,
  onCancel,
  onSaved,
}: {
  row: OperationalReport;
  index: number;
  sources: string[];
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const p = row.payment!;
  // Room and note are not correctable here any more: they are not asked for,
  // and an older row keeps whatever it recorded — they are simply not sent.
  const [draft, setDraft] = useState({
    ezCode: p.ezCode ?? '',
    source: p.source ?? '',
    guestName: p.guestName ?? '',
    method: p.method,
    amount: groupDigits(String(p.amount)),
    receivable: groupDigits(String(p.receivable)),
    expense: groupDigits(String(p.expense)),
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      reportsApi.update(row.id, {
        payment: {
          ezCode: draft.ezCode.trim(),
          source: draft.source,
          guestName: draft.guestName.trim(),
          method: draft.method,
          amount: parseVnd(draft.amount) ?? 0,
          receivable: parseVndOrZero(draft.receivable),
          expense: parseVndOrZero(draft.expense),
        },
      }),
    onSuccess: async () => {
      setError(null);
      await onSaved();
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  const cell = 'w-full rounded-lg border border-slate-300 px-2 py-1 text-xs';

  return (
    <tr data-testid={`payment-edit-row-${row.id}`} className="bg-amber-50/40">
      <td className="px-3 py-2 align-top text-slate-400">{index + 1}</td>
      <td className="px-2 py-2 align-top">
        <input className={cell} value={draft.guestName} onChange={(e) => setDraft({ ...draft, guestName: e.target.value })} />
        {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
      </td>
      <td className="px-2 py-2 align-top">
        <input className={cell} value={draft.ezCode} onChange={(e) => setDraft({ ...draft, ezCode: e.target.value })} />
      </td>
      <td className="px-2 py-2 align-top">
        <SourceSelect
          value={draft.source}
          onChange={(v) => setDraft({ ...draft, source: v })}
          sources={sources}
          className={cell}
          testId={`payment-edit-source-${row.id}`}
        />
      </td>
      {/*
        ONE AMOUNT AND ONE METHOD, across the two amount columns — not an amount
        box per column. The columns are a RENDERING of (method, amount); a box
        each would let a row be both cash and card at once.
      */}
      <td className="px-2 py-2 align-top" colSpan={2}>
        <div className="flex gap-1">
          <select
            className={cell}
            value={draft.method}
            data-testid={`payment-edit-method-${row.id}`}
            onChange={(e) => setDraft({ ...draft, method: e.target.value as PaymentMethod })}
          >
            <option value="CASH">Thu tiền mặt</option>
            <option value="TRANSFER">Chuyển khoản</option>
            <option value="CARD">Cà thẻ</option>
          </select>
          <input
            className={`${cell} text-right tabular-nums`}
            inputMode="numeric"
            value={draft.amount}
            data-testid={`payment-edit-amount-${row.id}`}
            onChange={(e) => setDraft({ ...draft, amount: groupDigits(e.target.value) })}
          />
        </div>
      </td>
      <td className="px-2 py-2 align-top">
        <input
          className={`${cell} text-right tabular-nums`}
          inputMode="numeric"
          value={draft.receivable}
          onChange={(e) => setDraft({ ...draft, receivable: groupDigits(e.target.value) })}
        />
      </td>
      <td className="px-2 py-2 align-top">
        <input
          className={`${cell} text-right tabular-nums`}
          inputMode="numeric"
          value={draft.expense}
          data-testid={`payment-edit-expense-${row.id}`}
          onChange={(e) => setDraft({ ...draft, expense: groupDigits(e.target.value) })}
        />
      </td>
      <td className="whitespace-nowrap px-3 py-2 align-top text-right">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          data-testid={`payment-save-${row.id}`}
          className="ml-1 inline-flex items-center gap-1 rounded-lg border border-brand-600 bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700"
        >
          <Check className="h-3 w-3" aria-hidden="true" />
          Lưu
        </button>
        <button
          type="button"
          onClick={onCancel}
          data-testid={`payment-cancel-${row.id}`}
          className="ml-1 inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600"
        >
          <X className="h-3 w-3" aria-hidden="true" />
          Hủy sửa
        </button>
      </td>
    </tr>
  );
}
