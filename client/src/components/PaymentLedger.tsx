/**
 * "THEO DÕI THANH TOÁN" — the front-desk cash ledger.
 *
 * LAYOUT, TOP TO BOTTOM
 *
 *   SUMMARY STRIP     tiền đầu ca (editable), số giao dịch, tổng theo từng
 *                     phương thức, công nợ, chi, và tiền cuối ca nổi bật
 *   DANH SÁCH GIAO DỊCH TRONG CA   every transaction this shift, immediately
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { formatVnd, groupDigits, parseVnd, parseVndOrZero } from '../lib/money';
import { CASH_KEY, REPORTS_KEY } from '../lib/reportKeys';

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
  const cash = useQuery({ queryKey: CASH_KEY, queryFn: () => reportsApi.cash() });

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

/* ------------------------------ Summary strip ------------------------------ */

/**
 * ONE ROW: [Tiền đầu ca] [Số giao dịch] [Thu tiền mặt] [Thu CK] [Cà thẻ]
 * [Công nợ] [Chi] [Tiền cuối ca].
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
    { label: 'Thu CK', value: formatVnd(summary.transferCollected) },
    { label: 'Cà thẻ', value: formatVnd(summary.cardCollected) },
    { label: 'Công nợ', value: formatVnd(summary.receivable) },
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
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-4 xl:grid-cols-8">
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
          <div className="bg-brand-50 px-3 py-2.5">
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
    <div className="col-span-2 space-y-1.5 bg-slate-50 px-3 py-2.5 sm:col-span-4 xl:col-span-2">
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
  roomNumber: '',
  method: 'CASH' as PaymentMethod,
  amount: '',
  receivable: '',
  expense: '',
  note: '',
};

function NewPaymentForm({
  methods,
  onCreated,
  onCancel,
  bare,
}: {
  methods?: ReportOptions['paymentMethods'];
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
          source: form.source.trim() || undefined,
          guestName: form.guestName.trim() || undefined,
          roomNumber: form.roomNumber.trim() || undefined,
          method: form.method,
          // Parsed at the boundary: the grouped display never leaves the field.
          amount: parseVnd(form.amount) ?? 0,
          receivable: parseVndOrZero(form.receivable),
          expense: parseVndOrZero(form.expense),
          note: form.note.trim() || undefined,
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
        THREE ROWS: who and where, then the money, then a note. Four equal columns
        on a wide screen so every field lines up with the one above it; two on a
        tablet; one on a phone.

        "NHÂN VIÊN" IS NOT A FIELD. It is whoever is on the open shift, decided by
        the server — so it is shown, not asked for.

        NO HELPER TEXT UNDER THE MONEY FIELDS. Which figures move the drawer is a
        rule the server applies (and the tests pin), not a sentence to re-read on
        every transaction — and the hints were what made the fields unequal.
      */}
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4" data-testid="payment-row-who">
        <Input label="Mã EZ" value={form.ezCode} onChange={(e) => set('ezCode', e.target.value)} data-testid="payment-ez" />
        <Input label="Nguồn" value={form.source} onChange={(e) => set('source', e.target.value)} data-testid="payment-source" />
        <Input label="Tên khách" value={form.guestName} onChange={(e) => set('guestName', e.target.value)} data-testid="payment-guest" />
        <Input label="Số phòng" value={form.roomNumber} onChange={(e) => set('roomNumber', e.target.value)} data-testid="payment-room" />
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
            className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-600"
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

      <Input label="Ghi chú" value={form.note} onChange={(e) => set('note', e.target.value)} data-testid="payment-note" />

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
  isLoading,
  isError,
  error,
  onRetry,
  onChanged,
  onSaved,
  onAdd,
}: {
  rows: OperationalReport[];
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
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">STT</th>
                <th className="px-3 py-2 text-left font-medium">Nhân viên</th>
                <th className="px-3 py-2 text-left font-medium">Mã EZ</th>
                <th className="px-3 py-2 text-left font-medium">Nguồn</th>
                <th className="px-3 py-2 text-left font-medium">Tên khách</th>
                <th className="px-3 py-2 text-left font-medium">Số phòng</th>
                <th className="px-3 py-2 text-right font-medium">Thu tiền mặt</th>
                <th className="px-3 py-2 text-right font-medium">Thu CK</th>
                <th className="px-3 py-2 text-right font-medium">Thu cà thẻ</th>
                <th className="px-3 py-2 text-right font-medium">Công nợ</th>
                <th className="px-3 py-2 text-right font-medium">Chi</th>
                <th className="px-3 py-2 text-left font-medium">Ghi chú</th>
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
      <td className="px-3 py-2.5 align-top">{row.createdByName}</td>
      <td className="px-3 py-2.5 align-top">{p.ezCode ?? '—'}</td>
      <td className="px-3 py-2.5 align-top">{p.source ?? '—'}</td>
      <td className="px-3 py-2.5 align-top">{p.guestName ?? '—'}</td>
      <td className="px-3 py-2.5 align-top">{p.roomNumber ?? '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums">{p.cash ? formatVnd(p.cash) : '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums">{p.transfer ? formatVnd(p.transfer) : '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums">{p.card ? formatVnd(p.card) : '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums">{p.receivable ? formatVnd(p.receivable) : '—'}</td>
      <td className="px-3 py-2.5 text-right align-top tabular-nums">{p.expense ? formatVnd(p.expense) : '—'}</td>
      <td className="max-w-[14rem] px-3 py-2.5 align-top">
        <span className="whitespace-pre-wrap">{p.note ?? '—'}</span>
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
  onCancel,
  onSaved,
}: {
  row: OperationalReport;
  index: number;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const p = row.payment!;
  const [draft, setDraft] = useState({
    ezCode: p.ezCode ?? '',
    source: p.source ?? '',
    guestName: p.guestName ?? '',
    roomNumber: p.roomNumber ?? '',
    method: p.method,
    amount: groupDigits(String(p.amount)),
    receivable: groupDigits(String(p.receivable)),
    expense: groupDigits(String(p.expense)),
    note: p.note ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      reportsApi.update(row.id, {
        payment: {
          ezCode: draft.ezCode.trim(),
          source: draft.source.trim(),
          guestName: draft.guestName.trim(),
          roomNumber: draft.roomNumber.trim(),
          method: draft.method,
          amount: parseVnd(draft.amount) ?? 0,
          receivable: parseVndOrZero(draft.receivable),
          expense: parseVndOrZero(draft.expense),
          note: draft.note.trim(),
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
      <td className="px-3 py-2 align-top text-xs text-slate-500">{row.createdByName}</td>
      <td className="px-2 py-2 align-top">
        <input className={cell} value={draft.ezCode} onChange={(e) => setDraft({ ...draft, ezCode: e.target.value })} />
      </td>
      <td className="px-2 py-2 align-top">
        <input className={cell} value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
      </td>
      <td className="px-2 py-2 align-top">
        <input className={cell} value={draft.guestName} onChange={(e) => setDraft({ ...draft, guestName: e.target.value })} />
      </td>
      <td className="px-2 py-2 align-top">
        <input className={cell} value={draft.roomNumber} onChange={(e) => setDraft({ ...draft, roomNumber: e.target.value })} />
      </td>
      {/*
        ONE AMOUNT AND ONE METHOD, not three amount boxes. The three columns are a
        RENDERING of (method, amount); three editable boxes would let a row be
        both cash and card at once, and the server would then have to pick one.
      */}
      <td className="px-2 py-2 align-top" colSpan={3}>
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
      <td className="px-2 py-2 align-top">
        <input className={cell} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
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
