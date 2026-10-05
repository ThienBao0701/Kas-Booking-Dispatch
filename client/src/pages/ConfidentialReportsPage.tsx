/**
 * "VII. BÁO CÁO CÁC VẤN ĐỀ VÀ TÌNH HÌNH QUAN TRỌNG" — private reports upward.
 *
 *   Lễ tân → Quản lý lễ tân (its branch) → Tổng quản lý → Admin
 *
 * A SENDER sees "+ Báo cáo vấn đề" and nothing it has sent: the report is not a
 * journal entry and has no place in anybody's ordinary lists. A READER (a
 * manager, the Admin) sees its own inbox — "Chưa đọc" / "Đã đọc", its own read
 * state. Who may be chosen, and who may read, is the SERVER's decision; this
 * page only shows what it is given.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, Mail, MailOpen, Plus, ShieldAlert } from 'lucide-react';
import {
  confidentialApi,
  type ConfidentialCategory,
  type ConfidentialRecipient,
  type ConfidentialReport,
} from '../api/confidentialReports';
import { toUserMessage } from '../api/errors';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import { formatDateTime } from '../lib/format';

const KEY = ['confidential-reports'];
const TITLE = 'VII. Báo cáo các vấn đề và tình hình quan trọng';

export function ConfidentialReportsPage() {
  const options = useQuery({ queryKey: [...KEY, 'options'], queryFn: () => confidentialApi.options() });
  const [composing, setComposing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const o = options.data;

  return (
    <div>
      <PageHeader
        title={TITLE}
        description="Báo cáo riêng gửi cấp trên. Chỉ người nhận được chọn và Admin đọc được."
        actions={
          o?.canSend ? (
            <Button onClick={() => setComposing(true)} data-testid="confidential-new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Báo cáo vấn đề
            </Button>
          ) : null
        }
      />
      <QueryState isLoading={options.isLoading} isError={options.isError} error={options.error} onRetry={() => void options.refetch()}>
        {o?.canRead ? (
          <Inbox />
        ) : (
          <div
            data-testid="confidential-sender-note"
            className="flex items-start gap-3 rounded-xl border-section border-line bg-white px-4 py-4 shadow-sm"
          >
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
            <p className="text-sm text-slate-600">
              Báo cáo được gửi riêng tới cấp trên bạn chọn và Admin. Báo cáo không hiện trong danh sách báo cáo thông
              thường và đồng nghiệp không xem được.
            </p>
          </div>
        )}
      </QueryState>
      {composing && o ? (
        <ComposeDialog
          options={o}
          onClose={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            setToast('Đã gửi báo cáo tới cấp trên.');
          }}
        />
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function Inbox() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<'UNREAD' | 'READ'>('UNREAD');
  const [opened, setOpened] = useState<ConfidentialReport | null>(null);
  const inbox = useQuery({ queryKey: [...KEY, 'inbox'], queryFn: () => confidentialApi.inbox(), refetchInterval: 60_000 });
  const open = useMutation({
    mutationFn: (id: string) => confidentialApi.open(id),
    onSuccess: ({ report }) => {
      setOpened(report);
      void queryClient.invalidateQueries({ queryKey: [...KEY, 'inbox'] });
    },
  });
  const all = inbox.data?.reports ?? [];
  const shown = all.filter((r) => (state === 'UNREAD' ? !r.read : r.read));
  const counts = inbox.data?.counts ?? { unread: 0, read: 0 };

  return (
    <section data-testid="confidential-inbox" className="overflow-hidden rounded-xl border-section border-line bg-white shadow-sm">
      <header className="flex flex-wrap items-center gap-2 border-b-rule border-line bg-slate-50 px-4 py-2.5">
        <ShieldAlert className="h-4 w-4 text-slate-500" aria-hidden="true" />
        <h2 className="mr-auto text-[15px] font-semibold text-slate-900">Hộp thư báo cáo</h2>
        <div role="tablist" aria-label="Trạng thái đọc" className="inline-flex overflow-hidden rounded-lg border border-line-strong">
          {(
            [
              ['UNREAD', 'Chưa đọc', counts.unread],
              ['READ', 'Đã đọc', counts.read],
            ] as const
          ).map(([value, label, n], i) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={state === value}
              onClick={() => setState(value)}
              data-testid={`confidential-tab-${value}`}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium ${i > 0 ? 'border-l border-line-strong' : ''} ${
                state === value ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {label}
              <span className={`rounded-full px-1.5 text-xs font-bold tabular-nums ${state === value ? 'bg-white/20' : 'bg-slate-100'}`}>{n}</span>
            </button>
          ))}
        </div>
      </header>
      <QueryState isLoading={inbox.isLoading} isError={inbox.isError} error={inbox.error} onRetry={() => void inbox.refetch()}>
        {shown.length === 0 ? (
          <EmptyState
            icon={<Mail className="h-6 w-6" aria-hidden="true" />}
            title={state === 'UNREAD' ? 'Không có báo cáo chưa đọc' : 'Chưa có báo cáo đã đọc'}
            message="Báo cáo gửi tới bạn sẽ hiện tại đây."
          />
        ) : (
          <ul className="divide-y-rule divide-line-subtle">
            {shown.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => open.mutate(r.id)}
                  data-testid={`confidential-item-${r.id}`}
                  data-unread={!r.read || undefined}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                    r.read ? '' : 'bg-brand-50/40'
                  }`}
                >
                  {r.read ? (
                    <MailOpen className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-label="Đã đọc" />
                  ) : (
                    <Mail className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-label="Chưa đọc" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{r.categoryLabel}</span>
                      <span className={`text-sm ${r.read ? 'font-medium text-slate-700' : 'font-semibold text-slate-900'}`}>
                        {r.sender.name}
                      </span>
                      <span className="text-xs text-slate-500">
                        {r.sender.roleLabel}
                        {r.branch ? ` · Chi nhánh ${r.branch.branchNumber}` : ''}
                      </span>
                      <span className="ml-auto text-xs tabular-nums text-slate-500">{formatDateTime(r.createdAt)}</span>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-sm text-slate-600">{r.preview}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {open.isError ? (
        <div className="px-4 pb-3">
          <ErrorAlert>{toUserMessage(open.error)}</ErrorAlert>
        </div>
      ) : null}
      {opened ? (
        <Modal open title={opened.categoryLabel} onClose={() => setOpened(null)}>
          <div className="space-y-3" data-testid="confidential-detail">
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div>
                <dt className="inline text-slate-500">Người gửi: </dt>
                <dd className="inline font-medium text-slate-900">
                  {opened.sender.name} · {opened.sender.roleLabel}
                </dd>
              </div>
              <div>
                <dt className="inline text-slate-500">Chi nhánh: </dt>
                <dd className="inline">{opened.branch ? `Chi nhánh ${opened.branch.branchNumber} — ${opened.branch.address}` : '—'}</dd>
              </div>
              <div>
                <dt className="inline text-slate-500">Thời gian: </dt>
                <dd className="inline tabular-nums">{formatDateTime(opened.createdAt)}</dd>
              </div>
              <div>
                <dt className="inline text-slate-500">Gửi đến: </dt>
                <dd className="inline">{opened.recipients.map((x) => (x.always ? `${x.name} (Admin)` : x.name)).join(', ') || 'Admin'}</dd>
              </div>
            </dl>
            <p className="whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2.5 text-sm leading-relaxed text-slate-900">{opened.content}</p>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

/** "+ Báo cáo vấn đề": the kind first, then the content and the recipients. */
function ComposeDialog({
  options,
  onClose,
  onSent,
}: {
  options: { categories: { code: ConfidentialCategory; label: string }[]; recipients: ConfidentialRecipient[] };
  onClose: () => void;
  onSent: () => void;
}) {
  const [category, setCategory] = useState<ConfidentialCategory | null>(null);
  const [content, setContent] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const send = useMutation({
    mutationFn: () => confidentialApi.send({ category: category!, content: content.trim(), recipientIds: chosen }),
    onSuccess: onSent,
  });
  const label = options.categories.find((c) => c.code === category)?.label;

  return (
    <Modal
      open
      title="Báo cáo vấn đề"
      onClose={onClose}
      footer={
        category ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Hủy
            </Button>
            <Button
              onClick={() => send.mutate()}
              disabled={content.trim().length === 0}
              loading={send.isPending}
              data-testid="confidential-send"
            >
              Gửi báo cáo
            </Button>
          </>
        ) : null
      }
    >
      {category === null ? (
        <div className="space-y-2" data-testid="confidential-categories">
          <p className="text-sm text-slate-600">Chọn loại vấn đề:</p>
          {options.categories.map((c, i) => (
            <button
              key={c.code}
              type="button"
              onClick={() => setCategory(c.code)}
              data-testid={`confidential-category-${c.code}`}
              className="flex w-full items-center gap-3 rounded-xl border border-line-strong bg-white px-4 py-3 text-left text-sm font-medium text-slate-900 hover:border-brand-600 hover:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-700">
                {i + 1}
              </span>
              {c.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-slate-700">Loại vấn đề</p>
            <p className="mt-1 flex items-center gap-2">
              <span className="rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-900" data-testid="confidential-chosen">
                {label}
              </span>
              <button
                type="button"
                onClick={() => setCategory(null)}
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                <ArrowLeft className="h-3 w-3" aria-hidden="true" />
                Chọn lại
              </button>
            </p>
          </div>
          <label className="block text-sm font-medium text-slate-700">
            <span className="mb-1.5 block">
              Nội dung <span className="text-rose-600">*</span>
            </span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              maxLength={5000}
              data-testid="confidential-content"
              className="block w-full rounded-xl border border-line-strong bg-white px-3 py-2.5 text-sm font-normal text-slate-900 hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </label>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">Gửi đến</legend>
            {/*
              THE SENDER'S SUPERIORS, nearest first, as the server lists them. The
              Admin is one of them, ticked and locked: it always receives the
              report, and the server adds it whatever is ticked here.
            */}
            <ul className="space-y-1.5" data-testid="confidential-recipients">
              {options.recipients
                .filter((r) => !r.always)
                .map((r) => (
                  <li key={r.id}>
                    <label className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-sm hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={chosen.includes(r.id)}
                        onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.id] : c.filter((x) => x !== r.id)))}
                        data-testid={`confidential-recipient-${r.id}`}
                        className="h-4 w-4 rounded border-line-strong text-brand-600"
                      />
                      <span className="font-medium text-slate-900">{r.fullName}</span>
                      <span className="text-xs text-slate-500">{r.roleLabel}</span>
                    </label>
                  </li>
                ))}
              {/* One line for the Admin however many Admin accounts there are. */}
              {options.recipients.some((r) => r.always) ? (
                <li>
                  <label className="flex items-center gap-2.5 rounded-lg border border-line bg-slate-50 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked
                      disabled
                      readOnly
                      data-testid="confidential-recipient-admin"
                      className="h-4 w-4 rounded border-line-strong text-brand-600 disabled:opacity-70"
                    />
                    <span className="font-medium text-slate-900">Admin</span>
                    <span className="text-xs text-slate-500">— Admin luôn nhận</span>
                  </label>
                </li>
              ) : null}
            </ul>
          </fieldset>
          {send.isError ? <ErrorAlert>{toUserMessage(send.error)}</ErrorAlert> : null}
        </div>
      )}
    </Modal>
  );
}
