/**
 * THE DISPATCH CHAIN OF A FACILITY INCIDENT, on screen.
 *
 *   Tổng quản lý kỹ thuật  "Giao việc"  →  A. Nhân sự (a Quản lý kỹ thuật, with instructions)
 *                                       →  B. Kĩ thuật (an in-house technician)
 *   Quản lý kỹ thuật       "Thuê ngoài" →  an outside person or company (no account)
 *                          "Hoàn thành thuê ngoài" — the repair cost is required (0 allowed)
 *
 * Every rule (who, which branch, which manager holds it) is the server's; these
 * dialogs only collect and pre-check what it will check again.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, User } from 'lucide-react';
import { issuesApi, type DelegationStep, type ExternalDispatchInput, type Issue } from '../api/issues';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { CompletionVerdictFields } from './CompletionVerdict';
import { ErrorAlert } from './ErrorAlert';
import { Input } from './Input';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';
import { EMPTY_VERDICT, verdictPayload, verdictReady, type VerdictValue } from '../lib/completionVerdict';
import { formatVnd, parseVnd } from '../lib/money';
import { formatDateTime } from '../lib/format';
import { phoneProblem } from '../lib/contractorPhone';

const AREA =
  'mt-1 w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';
const SELECT =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

function IssueHeading({ issue }: { issue: Issue }) {
  return (
    <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <span className="font-semibold">{issue.locationLabel}</span>
      {issue.branch ? ` · CN ${issue.branch.branchNumber}` : ''} — {issue.description}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * "Giao việc" — Tổng quản lý kỹ thuật
 * ------------------------------------------------------------------ */

export function GiveWorkDialog({ issue, onClose, onDone }: { issue: Issue; onClose: () => void; onDone: (message: string) => void }) {
  const [mode, setMode] = useState<'MANAGER' | 'TECHNICIAN' | null>(null);
  const [personId, setPersonId] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const managers = useQuery({
    queryKey: ['issues', 'managers', issue.branchId],
    queryFn: () => issuesApi.managers(issue.branchId),
    enabled: mode === 'MANAGER',
  });
  const technicians = useQuery({
    queryKey: ['issues', 'technicians', issue.branchId],
    queryFn: () => issuesApi.technicians(issue.branchId),
    enabled: mode === 'TECHNICIAN',
  });
  const people = mode === 'MANAGER' ? (managers.data?.managers ?? []) : (technicians.data?.technicians ?? []);
  const run = useMutation({
    mutationFn: () =>
      mode === 'MANAGER'
        ? issuesApi.dispatchToManager(issue.id, personId as number, note.trim())
        : issuesApi.assign(issue.id, personId as number, note.trim() || undefined),
    onSuccess: () => {
      const name = people.find((p) => p.id === personId)?.fullName ?? '';
      onDone(mode === 'MANAGER' ? `Đã giao việc cho quản lý kỹ thuật ${name}.` : `Đã giao kỹ thuật ${name}.`);
    },
  });
  // Instructions are required for a Quản lý kỹ thuật, optional for a technician.
  const ready = mode !== null && personId !== '' && (mode === 'TECHNICIAN' || note.trim().length > 0);

  return (
    <Modal
      open
      title="Giao việc"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button onClick={() => run.mutate()} disabled={!ready} loading={run.isPending} data-testid="give-work-confirm">
            Giao việc
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="give-work">
        <IssueHeading issue={issue} />
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Giao cho">
          {(
            [
              ['MANAGER', 'A. Nhân sự', 'Quản lý kỹ thuật của chi nhánh'],
              ['TECHNICIAN', 'B. Kĩ thuật', 'Kỹ thuật viên khách sạn'],
            ] as const
          ).map(([value, title, hint]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${
                mode === value ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-slate-700 hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name="give-work-mode"
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  setPersonId('');
                }}
                data-testid={`give-work-${value}`}
                className="mt-0.5 h-4 w-4 accent-brand-600"
              />
              <span>
                <span className="block font-semibold">{title}</span>
                <span className="block text-xs text-slate-500">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {mode ? (
          <>
            <label className="block text-sm font-medium text-slate-700">
              {mode === 'MANAGER' ? 'Quản lý kỹ thuật' : 'Kỹ thuật viên'}
              <select
                className={SELECT}
                value={personId}
                onChange={(e) => setPersonId(e.target.value === '' ? '' : Number(e.target.value))}
                data-testid="give-work-person"
              >
                <option value="">— Chọn —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
              </select>
            </label>
            {mode === 'MANAGER' && managers.isSuccess && people.length === 0 ? (
              <p className="text-xs text-amber-800">Chi nhánh này chưa có quản lý kỹ thuật được phân công.</p>
            ) : null}
            {mode === 'TECHNICIAN' && technicians.isSuccess && people.length === 0 ? (
              <p className="text-xs text-amber-800" data-testid="no-branch-technicians">
                Chi nhánh này chưa có kỹ thuật viên được phân công. Admin cần chọn chi nhánh cho tài khoản kỹ thuật viên.
              </p>
            ) : null}
            <label className="block text-sm font-medium text-slate-700">
              Ghi chú / hướng dẫn công việc{mode === 'MANAGER' ? ' (bắt buộc)' : ' (không bắt buộc)'}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={2000}
                data-testid="give-work-note"
                className={AREA}
              />
            </label>
          </>
        ) : null}
        {run.isError ? <ErrorAlert>{toUserMessage(run.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * "Thuê ngoài" — Quản lý kỹ thuật
 * ------------------------------------------------------------------ */

export function ExternalDispatchDialog({ issue, onClose, onDone }: { issue: Issue; onClose: () => void; onDone: (message: string) => void }) {
  const [form, setForm] = useState<ExternalDispatchInput>({ name: '', phone: '', specialty: '', type: 'INDIVIDUAL', company: '', note: '' });
  const [tried, setTried] = useState(false);
  const set = <K extends keyof ExternalDispatchInput>(key: K, value: ExternalDispatchInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const problems: Partial<Record<keyof ExternalDispatchInput, string>> = {
    ...(form.name.trim() ? {} : { name: 'Vui lòng nhập họ và tên.' }),
    ...(phoneProblem(form.phone) ? { phone: phoneProblem(form.phone)! } : {}),
    ...(form.specialty.trim() ? {} : { specialty: 'Vui lòng nhập chuyên môn.' }),
    ...(form.type === 'COMPANY' && !form.company?.trim() ? { company: 'Vui lòng nhập tên công ty.' } : {}),
    ...(form.note.trim() ? {} : { note: 'Vui lòng nhập ghi chú / hướng dẫn công việc.' }),
  };
  const valid = Object.keys(problems).length === 0;
  const show = (key: keyof ExternalDispatchInput) => (tried ? problems[key] : undefined);
  const run = useMutation({
    mutationFn: () =>
      issuesApi.dispatchExternal(issue.id, {
        name: form.name.trim(),
        phone: form.phone.trim(),
        specialty: form.specialty.trim(),
        type: form.type,
        ...(form.type === 'COMPANY' ? { company: form.company?.trim() } : {}),
        note: form.note.trim(),
      }),
    onSuccess: () => onDone(`Đã giao cho kĩ thuật bên ngoài: ${form.name.trim()}.`),
  });

  return (
    <Modal
      open
      title="Giao cho kĩ thuật bên ngoài"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => {
              setTried(true);
              if (valid) run.mutate();
            }}
            loading={run.isPending}
            data-testid="external-confirm"
          >
            Giao việc
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="external-dispatch">
        <IssueHeading issue={issue} />
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Loại">
          {(
            [
              ['INDIVIDUAL', 'Cá nhân', User],
              ['COMPANY', 'Công ty', Building2],
            ] as const
          ).map(([value, label, Icon]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium ${
                form.type === value ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-slate-700 hover:bg-slate-50'
              }`}
            >
              <input type="radio" name="contractor-type" checked={form.type === value} onChange={() => set('type', value)} data-testid={`external-type-${value}`} className="h-4 w-4 accent-brand-600" />
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Họ và tên" required value={form.name} onChange={(e) => set('name', e.target.value)} error={show('name')} data-testid="external-name" />
          <Input label="Số điện thoại" required inputMode="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} error={show('phone')} data-testid="external-phone" />
          <Input label="Chuyên môn" required value={form.specialty} onChange={(e) => set('specialty', e.target.value)} error={show('specialty')} data-testid="external-specialty" />
          {form.type === 'COMPANY' ? (
            <Input label="Tên công ty" required value={form.company ?? ''} onChange={(e) => set('company', e.target.value)} error={show('company')} data-testid="external-company" />
          ) : null}
        </div>
        <label className="block text-sm font-medium text-slate-700">
          Ghi chú / hướng dẫn công việc (bắt buộc)
          <textarea value={form.note} onChange={(e) => set('note', e.target.value)} rows={3} maxLength={2000} data-testid="external-note" className={AREA} />
        </label>
        {show('note') ? <p className="text-xs text-rose-700">{problems.note}</p> : null}
        <p className="text-xs text-slate-500">Không tạo tài khoản cho người bên ngoài. Thông tin liên hệ chỉ quản lý kỹ thuật và Admin xem được.</p>
        {run.isError ? <ErrorAlert>{toUserMessage(run.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * "Hoàn thành thuê ngoài" — the cost is required
 * ------------------------------------------------------------------ */

export function CompleteExternalDialog({ issue, onClose, onDone }: { issue: Issue; onClose: () => void; onDone: (message: string) => void }) {
  const [cost, setCost] = useState('');
  const [verdict, setVerdict] = useState<VerdictValue>({ ...EMPTY_VERDICT, verdict: 'CORRECT' });
  const amount = parseVnd(cost);
  const run = useMutation({
    mutationFn: () => issuesApi.completeExternal(issue.id, { repairCost: amount!, ...verdictPayload(verdict) }),
    onSuccess: () => onDone(`Đã hoàn thành — chi phí sửa chữa ${formatVnd(amount)}.`),
  });
  const contractor = issue.externalWork?.contractor;

  return (
    <Modal
      open
      title="Hoàn thành công việc thuê ngoài"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => run.mutate()}
            disabled={amount === null || !verdictReady(verdict)}
            loading={run.isPending}
            data-testid="complete-external-confirm"
          >
            Hoàn thành
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="complete-external">
        <IssueHeading issue={issue} />
        {contractor ? (
          <p className="text-sm text-slate-700">
            Kĩ thuật bên ngoài: <span className="font-medium">{contractor.name}</span>
            {contractor.company ? ` — ${contractor.company}` : ` (${contractor.typeLabel})`}
          </p>
        ) : null}
        <MoneyInput
          label="Chi phí sửa chữa"
          required
          value={cost}
          onChange={setCost}
          hint="Bắt buộc. Nhập 0 nếu không phát sinh chi phí."
          data-testid="complete-external-cost"
        />
        <CompletionVerdictFields value={verdict} onChange={setVerdict} resolutionLabel="Kết quả / ghi chú hoàn thành (nếu có)" />
        {run.isError ? <ErrorAlert>{toUserMessage(run.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * The delegation chain, read in the incident detail
 * ------------------------------------------------------------------ */

const KIND_TONE: Record<DelegationStep['kind'], string> = {
  TO_MANAGER: 'bg-indigo-100 text-indigo-800',
  TO_TECHNICIAN: 'bg-sky-100 text-sky-800',
  TO_EXTERNAL: 'bg-amber-100 text-amber-900',
};

const STATE_TONE: Record<DelegationStep['state'], string> = {
  ACTIVE: 'text-brand-700',
  ENDED: 'text-slate-500',
  RETURNED: 'text-slate-500',
  COMPLETED: 'text-emerald-700',
};

/**
 * "CHUỖI GIAO VIỆC" — every hand-off, oldest first, each labelled as what it is
 * (to a Quản lý kỹ thuật, to an in-house technician, to an outside contractor).
 * A step taken under a manager's hand-off sits indented beneath it, so the
 * chain Tổng QLKT → QLKT → kĩ thuật reads top to bottom. Contact details show
 * only when the server sent them (contractor privacy is the server's).
 */
export function IssueDelegationChain({ issue }: { issue: Pick<Issue, 'delegationChain'> }) {
  const steps = issue.delegationChain ?? [];
  if (steps.length === 0) return null;
  const byId = new Map(steps.map((st) => [st.id, st]));
  return (
    <section data-testid="issue-delegation-chain" className="rounded-xl border border-line bg-white px-3 py-2.5">
      <h4 className="mb-1.5 font-semibold uppercase tracking-wide text-slate-600">Chuỗi giao việc</h4>
      <ol className="space-y-2">
        {steps.map((st) => {
          const parent = st.parentId ? byId.get(st.parentId) : undefined;
          const contractor = st.to.contractor;
          return (
            <li
              key={st.id}
              data-testid={`delegation-${st.id}`}
              data-kind={st.kind}
              className={`border-l-2 border-slate-200 pl-2.5 ${parent ? 'ml-5' : ''}`}
            >
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-slate-800">
                <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold ${KIND_TONE[st.kind]}`}>{st.kindLabel}</span>
                <span className="font-semibold">{st.by.name}</span>
                {st.by.roleLabel ? <span className="text-xs text-slate-500">({st.by.roleLabel})</span> : null}
                <span aria-hidden="true">→</span>
                <span className="font-semibold">
                  {st.to.name}
                  {contractor ? (contractor.company ? ` — ${contractor.company}` : ` (${contractor.typeLabel})`) : ''}
                </span>
                <span className="text-xs text-slate-500">· {formatDateTime(st.at)}</span>
              </p>
              {parent ? (
                <p className="text-xs text-slate-500" data-testid={`delegation-parent-${st.id}`}>
                  Thuộc phần việc giao cho {parent.to.name}
                </p>
              ) : null}
              {contractor?.phone || contractor?.specialty ? (
                <p className="text-xs text-slate-600">{[contractor.phone, contractor.specialty].filter(Boolean).join(' · ')}</p>
              ) : null}
              {st.note ? <p className="whitespace-pre-wrap text-slate-600">{st.note}</p> : null}
              <p className={`text-xs font-medium ${STATE_TONE[st.state]}`} data-testid={`delegation-state-${st.id}`}>
                {st.stateLabel}
                {st.completedAt ? ` · ${formatDateTime(st.completedAt)}${st.completedByName ? ` bởi ${st.completedByName}` : ''}` : ''}
                {st.repairCost !== null ? ` — chi phí ${formatVnd(st.repairCost)}` : ''}
                {st.completionNote ? ` — ${st.completionNote}` : ''}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
