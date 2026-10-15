import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, History, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import {
  roomMappingApi,
  type RoomClassView,
  type RoomMappingVersionView,
} from '../api/roomMapping';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';
import { InlineSpinner } from './PageState';
import { formatDateTime } from '../lib/format';

const inputClass =
  'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

interface Props {
  branchId: number;
  branchLabel: string;
  onClose: () => void;
}

/**
 * Admin room-class management for ONE branch.
 *
 * The whole point of the screen is the separation between the live mapping and
 * a draft: the ACTIVE table is read-only, and every edit goes into a draft that
 * reception never sees until it is explicitly activated.
 */
export function RoomClassManager({ branchId, branchLabel, onClose }: Props) {
  const queryClient = useQueryClient();
  const [confirmActivate, setConfirmActivate] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reason, setReason] = useState('');

  const mappingKey = ['room-mapping', branchId];
  const mapping = useQuery({ queryKey: mappingKey, queryFn: () => roomMappingApi.get(branchId) });
  const versions = useQuery({
    queryKey: ['room-mapping-versions', branchId],
    queryFn: () => roomMappingApi.versions(branchId),
    enabled: showHistory,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: mappingKey });

  const active = mapping.data?.active ?? null;
  const draft = mapping.data?.draft ?? null;

  const createDraft = useMutation({
    mutationFn: () => roomMappingApi.createDraft(branchId),
    onSuccess: () => void refresh(),
  });
  const cancelDraft = useMutation({
    mutationFn: () => roomMappingApi.cancelDraft(branchId, draft!.id),
    onSuccess: () => void refresh(),
  });
  const validate = useMutation({ mutationFn: () => roomMappingApi.validate(branchId, draft!.id) });
  const activate = useMutation({
    mutationFn: () => roomMappingApi.activate(branchId, draft!.id, active?.id ?? null, reason || undefined),
    onSuccess: () => {
      setConfirmActivate(false);
      setReason('');
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ['room-mapping-versions', branchId] });
    },
  });

  return (
    <Modal
      open
      size="2xl"
      title={`Hạng phòng — ${branchLabel}`}
      onClose={onClose}
      footer={<Button variant="secondary" onClick={onClose}>Đóng</Button>}
    >
      {mapping.isLoading ? <InlineSpinner /> : null}
      {mapping.isError ? <ErrorAlert>{toUserMessage(mapping.error)}</ErrorAlert> : null}

      {mapping.data ? (
        <div className="space-y-5">
          {/* ---------------- ACTIVE ---------------- */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800">
                Đang áp dụng{active ? ` — phiên bản ${active.versionNumber}` : ''}
              </h3>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setShowHistory((v) => !v)}>
                  <History className="h-4 w-4" aria-hidden="true" />
                  Lịch sử phiên bản
                </Button>
                {!draft ? (
                  <Button onClick={() => createDraft.mutate()} loading={createDraft.isPending}>
                    Tạo bản cập nhật
                  </Button>
                ) : null}
              </div>
            </div>

            {active ? (
              <RoomClassTable classes={active.roomClasses} caption={`Hạng phòng đang áp dụng cho ${branchLabel}`} />
            ) : (
              <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Chi nhánh này chưa có cấu hình hạng phòng. Đơn mới sẽ không tự xác định được mã phòng.
              </p>
            )}
            {createDraft.isError ? <div className="mt-2"><ErrorAlert>{toUserMessage(createDraft.error)}</ErrorAlert></div> : null}
          </section>

          {/* ---------------- DRAFT ---------------- */}
          {draft ? (
            <section className="rounded-2xl border border-brand-300 bg-brand-50/40 p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-800">
                  Bản nháp — phiên bản {draft.versionNumber}
                </h3>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => validate.mutate()} loading={validate.isPending}>
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    Kiểm tra
                  </Button>
                  <Button onClick={() => setConfirmActivate(true)}>Kích hoạt cập nhật</Button>
                  <Button variant="danger" onClick={() => cancelDraft.mutate()} loading={cancelDraft.isPending}>
                    Huỷ bản nháp
                  </Button>
                </div>
              </div>

              <p className="mb-3 text-xs text-slate-600">
                Bản nháp không ảnh hưởng tới hoạt động hiện tại. Lễ tân vẫn dùng cấu hình đang áp dụng
                cho tới khi bạn bấm kích hoạt.
              </p>

              {validate.data ? (
                validate.data.ok ? (
                  <p className="mb-3 rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
                    Bản nháp hợp lệ ({validate.data.activeClassCount} hạng phòng đang bật).
                  </p>
                ) : (
                  <ul className="mb-3 space-y-1 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                    {validate.data.problems.map((p) => (
                      <li key={`${p.code}-${p.roomClassId ?? 'x'}`}>{p.message}</li>
                    ))}
                  </ul>
                )
              ) : null}

              <DraftEditor branchId={branchId} draft={draft} onChanged={refresh} />
            </section>
          ) : null}

          {/* ---------------- VERSION HISTORY ---------------- */}
          {showHistory ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-800">Lịch sử phiên bản</h3>
              {versions.isLoading ? <InlineSpinner /> : null}
              <ul className="space-y-1 text-sm">
                {(versions.data?.versions ?? []).map((v) => (
                  <li key={v.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                    <span>
                      <span className="font-medium">Phiên bản {v.versionNumber}</span>{' '}
                      <VersionBadge status={v.status} />{' '}
                      <span className="text-slate-500">{v.roomClasses.length} hạng phòng</span>
                    </span>
                    <span className="text-xs text-slate-500">
                      {v.activatedAt ? `Kích hoạt ${formatDateTime(v.activatedAt)}` : `Tạo ${formatDateTime(v.createdAt)}`}
                      {v.activatedBy ? ` · ${v.activatedBy.fullName}` : ''}
                      {v.changeReason ? ` · ${v.changeReason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

      {/* ---------------- ACTIVATION CONFIRMATION ---------------- */}
      <Modal
        open={confirmActivate}
        title="Kích hoạt cấu hình hạng phòng mới"
        onClose={() => setConfirmActivate(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmActivate(false)}>Huỷ</Button>
            <Button onClick={() => activate.mutate()} loading={activate.isPending}>Kích hoạt</Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          {branchLabel}: phiên bản {active?.versionNumber ?? '—'} → {draft?.versionNumber ?? '—'}
        </p>

        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="flex items-start gap-1.5 font-medium">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            Đơn đã tạo sẽ GIỮ NGUYÊN mã phòng cũ.
          </p>
          <ul className="mt-1 list-inside list-disc text-xs">
            <li>Chỉ đơn tạo mới sau khi kích hoạt mới dùng cấu hình mới.</li>
            <li>Ghi chú đã tạo trước đó không bị viết lại.</li>
            <li>Đơn đã hoàn thành hoặc lưu trữ không bị tính lại.</li>
          </ul>
        </div>

        {draft && active ? <ChangeSummary before={active} after={draft} /> : null}

        <label className="mt-3 block text-sm font-medium text-slate-600">
          Lý do thay đổi (tuỳ chọn)
          <input className={`${inputClass} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>

        {activate.isError ? <div className="mt-3"><ErrorAlert>{toUserMessage(activate.error)}</ErrorAlert></div> : null}
      </Modal>
    </Modal>
  );
}

function VersionBadge({ status }: { status: RoomMappingVersionView['status'] }) {
  const styles: Record<string, string> = {
    ACTIVE: 'bg-green-100 text-green-700',
    DRAFT: 'bg-brand-100 text-brand-700',
    ARCHIVED: 'bg-slate-100 text-slate-500',
  };
  const label: Record<string, string> = { ACTIVE: 'Đang áp dụng', DRAFT: 'Bản nháp', ARCHIVED: 'Đã lưu trữ' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>{label[status]}</span>;
}

function RoomClassTable({ classes, caption }: { classes: RoomClassView[]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th scope="col" className="py-2 pr-3">Tên hạng phòng</th>
            <th scope="col" className="py-2 pr-3">Mã PMS</th>
            <th scope="col" className="py-2 pr-3">Tên gọi khác</th>
            <th scope="col" className="py-2 pr-3">Thứ tự</th>
            <th scope="col" className="py-2">Trạng thái</th>
          </tr>
        </thead>
        <tbody>
          {classes.map((c) => (
            <tr key={c.id} className="border-b border-slate-100 last:border-b-0 align-top">
              <td className="py-2 pr-3 font-medium text-slate-800">{c.displayName}</td>
              <td className="py-2 pr-3 font-mono text-xs text-slate-700">{c.pmsCode}</td>
              <td className="py-2 pr-3 text-xs text-slate-500">
                {c.aliases.length > 0 ? c.aliases.map((a) => a.alias).join(', ') : '—'}
              </td>
              <td className="py-2 pr-3 text-slate-500">{c.sortOrder}</td>
              <td className="py-2">
                {c.active ? (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Đang dùng</span>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">Đã tắt</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangeSummary({ before, after }: { before: RoomMappingVersionView; after: RoomMappingVersionView }) {
  const byKey = new Map(before.roomClasses.map((c) => [c.stableKey, c]));
  const added = after.roomClasses.filter((c) => !byKey.has(c.stableKey) && c.active);
  const changed = after.roomClasses.filter((c) => {
    const old = byKey.get(c.stableKey);
    return old && old.active && c.active && (old.pmsCode !== c.pmsCode || old.displayName !== c.displayName);
  });
  const off = after.roomClasses.filter((c) => byKey.get(c.stableKey)?.active && !c.active);

  if (added.length + changed.length + off.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">Không có thay đổi về hạng phòng.</p>;
  }

  return (
    <div className="mt-3 space-y-1 text-sm">
      {added.length > 0 ? <p><span className="font-medium text-green-700">Thêm:</span> {added.map((c) => `${c.displayName} (${c.pmsCode})`).join(', ')}</p> : null}
      {changed.length > 0 ? (
        <p>
          <span className="font-medium text-amber-700">Sửa:</span>{' '}
          {changed.map((c) => `${byKey.get(c.stableKey)!.displayName} (${byKey.get(c.stableKey)!.pmsCode}) → ${c.displayName} (${c.pmsCode})`).join('; ')}
        </p>
      ) : null}
      {off.length > 0 ? <p><span className="font-medium text-red-700">Tắt:</span> {off.map((c) => c.displayName).join(', ')}</p> : null}
    </div>
  );
}

/** Inline editing of the draft: add classes, change codes, aliases, on/off. */
function DraftEditor({
  branchId,
  draft,
  onChanged,
}: {
  branchId: number;
  draft: RoomMappingVersionView;
  onChanged: () => void;
}) {
  const [newClass, setNewClass] = useState({ displayName: '', pmsCode: '' });
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({});

  const add = useMutation({
    mutationFn: () => roomMappingApi.addRoomClass(branchId, draft.id, newClass),
    onSuccess: () => {
      setNewClass({ displayName: '', pmsCode: '' });
      onChanged();
    },
  });
  const patch = useMutation({
    mutationFn: (vars: { id: string; body: { pmsCode?: string; displayName?: string; active?: boolean } }) =>
      roomMappingApi.updateRoomClass(branchId, draft.id, vars.id, vars.body),
    onSuccess: onChanged,
  });
  const alias = useMutation({
    mutationFn: (vars: { id: string; alias: string }) =>
      roomMappingApi.addAlias(branchId, draft.id, vars.id, vars.alias),
    onSuccess: (_r, vars) => {
      setAliasDraft((prev) => ({ ...prev, [vars.id]: '' }));
      onChanged();
    },
  });
  const dropAlias = useMutation({
    mutationFn: (aliasId: string) => roomMappingApi.removeAlias(branchId, draft.id, aliasId),
    onSuccess: onChanged,
  });

  /**
   * Sends whatever alias text is pending for a class, if any.
   *
   * One place, called from both blur and Enter, so the two can never drift
   * apart again. A blank box is a no-op rather than a rejected request, and the
   * text is left in place until the server accepts it — a refused duplicate
   * stays on screen to be corrected instead of vanishing.
   */
  function commitAlias(roomClassId: string): void {
    const value = (aliasDraft[roomClassId] ?? '').trim();
    if (value.length === 0 || alias.isPending) return;
    alias.mutate({ id: roomClassId, alias: value });
  }

  const error = add.error ?? patch.error ?? alias.error ?? dropAlias.error;

  return (
    <div className="space-y-3">
      {error ? <ErrorAlert>{toUserMessage(error)}</ErrorAlert> : null}

      {/*
        The list scrolls on its own, independently of the dialog around it, so
        the draft's actions above and the close button below stay reachable no
        matter how many room classes a branch has.

        `max-h` is in rem rather than vh: this list sits inside a dialog that is
        already capped at the viewport, and a second vh cap would fight it.
      */}
      <ul className="max-h-96 space-y-2 overflow-y-auto overscroll-contain pr-1" data-testid="room-class-list">
        {draft.roomClasses.map((c) => (
          <li key={c.id} className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              {/*
                THE NAME IS EDITABLE, not a label. `updateRoomClass` has always
                accepted `displayName`; only the input was missing, so an Admin
                could correct a typo in a code but had to delete and recreate a
                class to correct one in its name — losing its aliases with it.

                Committed on blur exactly like the code beside it, and only when
                the value actually changed, so tabbing through edits nothing.
              */}
              <label className="sr-only" htmlFor={`name-${c.id}`}>Tên hạng phòng</label>
              <input
                id={`name-${c.id}`}
                data-testid={`room-class-name-${c.id}`}
                className={`${inputClass} min-w-32 flex-1 font-medium`}
                defaultValue={c.displayName}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== c.displayName) {
                    patch.mutate({ id: c.id, body: { displayName: value } });
                  }
                }}
              />
              <label className="sr-only" htmlFor={`code-${c.id}`}>Mã PMS của {c.displayName}</label>
              <input
                id={`code-${c.id}`}
                data-testid={`room-class-code-${c.id}`}
                className={`${inputClass} w-40 font-mono`}
                defaultValue={c.pmsCode}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== c.pmsCode) patch.mutate({ id: c.id, body: { pmsCode: value } });
                }}
              />
              <Button
                variant={c.active ? 'secondary' : 'primary'}
                onClick={() => patch.mutate({ id: c.id, body: { active: !c.active } })}
              >
                {c.active ? 'Tắt' : 'Bật'}
              </Button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              {c.aliases.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                  {a.alias}
                  <button
                    type="button"
                    aria-label={`Xoá tên gọi ${a.alias}`}
                    className="text-slate-400 hover:text-red-600"
                    onClick={() => dropAlias.mutate(a.id)}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              {/*
                COMMITS ON BLUR AS WELL AS ENTER.

                This was the bug: the name and the PMS code beside it save on
                blur, but the alias saved only on Enter. An Admin who typed a
                "tên gọi khác" and then clicked "Kích hoạt cập nhật" never
                pressed Enter, so the text sat in local React state and was
                thrown away — the field looked accepted and the alias silently
                never existed. Nothing was wrong with the request, the service or
                the schema; the value was simply never sent.

                Blurring is also what clicking the activate button does first, so
                the alias is saved into the draft before it is promoted.
              */}
              <label className="sr-only" htmlFor={`alias-${c.id}`}>Thêm tên gọi khác cho {c.displayName}</label>
              <input
                id={`alias-${c.id}`}
                data-testid={`room-class-alias-input-${c.id}`}
                className="w-40 rounded-full border border-slate-300 px-2 py-0.5"
                placeholder="Thêm tên gọi khác"
                value={aliasDraft[c.id] ?? ''}
                onChange={(e) => setAliasDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                onBlur={() => commitAlias(c.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  // Prevent the Enter from also submitting anything around it.
                  e.preventDefault();
                  commitAlias(c.id);
                }}
              />
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 p-3">
        <label className="text-sm font-medium text-slate-600">
          Tên hạng phòng
          <input
            className={`${inputClass} mt-1 w-48`}
            value={newClass.displayName}
            onChange={(e) => setNewClass({ ...newClass, displayName: e.target.value })}
          />
        </label>
        <label className="text-sm font-medium text-slate-600">
          Mã PMS
          <input
            className={`${inputClass} mt-1 w-36 font-mono`}
            value={newClass.pmsCode}
            onChange={(e) => setNewClass({ ...newClass, pmsCode: e.target.value })}
          />
        </label>
        <Button
          onClick={() => add.mutate()}
          disabled={!newClass.displayName.trim() || !newClass.pmsCode.trim()}
          loading={add.isPending}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Thêm hạng phòng
        </Button>
      </div>
    </div>
  );
}
