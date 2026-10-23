/**
 * "+ BÁO CÁO VẤN ĐỀ" — from the room or area being worked, in two taps.
 *
 * The branch, the place, the work item, the reporter and the time are filled in
 * (the server takes them from the account and the item, never from here). No
 * guest is asked: Reception names the guest afterwards. It goes through the
 * same reporting as "Báo cáo vấn đề":
 *
 *   Khách yêu cầu   a GUEST_REQUEST journal entry tied to the item
 *   Sự cố cơ sở     the incident for Kỹ thuật, at this place, then its journal
 *                   entry tied to the item
 *
 * Nothing about the room's work or its stock changes. A double tap sends once;
 * a retry after the incident was created only writes the missing journal entry.
 */
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { issuesApi, type NewIssueInput } from '../api/issues';
import { reportsApi, type Severity } from '../api/receptionReports';
import { ApiError, toUserMessage } from '../api/errors';
import type { RoomTask } from '../api/roomWork';
import { useAuth } from '../auth/AuthProvider';
import { DEFAULT_SEVERITY } from '../lib/severity';
import { FACILITY_BOARD_KEY, REPORTS_KEY } from '../lib/reportKeys';
import { placeText } from '../lib/workPlaces';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';
import { SeverityPicker } from './Severity';
import { DepartmentPicker, type DepartmentChoice } from './OperationalForms';
import { maySelfClaim } from '../lib/requestWork';

const SENT_TO: Record<DepartmentChoice, string> = {
  BELL: 'Đã gửi yêu cầu của khách cho Bell.',
  RECEPTION: 'Đã gửi yêu cầu của khách cho lễ tân.',
  HOUSEKEEPING: 'Đã gửi yêu cầu của khách cho Buồng phòng.',
  SELF: 'Đã ghi nhận yêu cầu — bạn là người xử lý.',
};

type Kind = 'GUEST_REQUEST' | 'FACILITY_ISSUE';

/** Where the incident is, in the incident form's own terms. */
function issueAreaOf(task: RoomTask): Pick<NewIssueInput, 'areaCategory' | 'roomNumber' | 'floorNumber' | 'locationDetail'> {
  const kind = task.areaKind ?? 'ROOM';
  if (kind === 'ROOM') return { areaCategory: 'ROOM', roomNumber: task.roomNumber };
  if ((kind === 'HALLWAY' || kind === 'STAIRCASE') && task.floor) return { areaCategory: kind, floorNumber: task.floor };
  if (kind === 'ROOFTOP') return { areaCategory: 'ROOFTOP' };
  // "Khác" of a floor (or an area whose floor is unknown): the place in words.
  return { areaCategory: 'OTHER_AREA', locationDetail: placeText(task) };
}

export function QuickReportDialog({ task, onClose, onDone }: { task: RoomTask; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const me = useAuth().user;
  const [kind, setKind] = useState<Kind>('FACILITY_ISSUE');
  const [content, setContent] = useState('');
  const [severity, setSeverity] = useState<Severity>(DEFAULT_SEVERITY);
  // "Bộ phận nhận việc" of a guest request — or "Tự nhận việc".
  const [department, setDepartment] = useState<DepartmentChoice | ''>('');
  // The incident already created by an earlier try: a retry only writes the journal entry.
  const createdIssue = useRef<string | null>(null);
  const send = useMutation({
    // `confirmDuplicate`: "Vẫn gửi" after a possible duplicate; `allowUnassigned`: "Vẫn lưu, chờ giao" when nobody is on shift.
    mutationFn: async ({ confirmDuplicate = false, allowUnassigned = false }: { confirmDuplicate?: boolean; allowUnassigned?: boolean } = {}) => {
      const note = content.trim();
      if (kind === 'GUEST_REQUEST') {
        await reportsApi.create({
          category: 'GUEST_REQUEST',
          guestRequest: { note, severity, receivingDepartment: department || undefined },
          taskId: task.id,
          confirmDuplicate,
          ...(allowUnassigned ? { allowUnassigned } : {}),
        });
        return;
      }
      if (!createdIssue.current) {
        const { issue } = await issuesApi.create({ ...issueAreaOf(task), description: note, severity });
        createdIssue.current = issue.id;
      }
      await reportsApi.create({ category: 'FACILITY_ISSUE', facility: { issueId: createdIssue.current }, taskId: task.id });
    },
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: REPORTS_KEY }), queryClient.invalidateQueries({ queryKey: FACILITY_BOARD_KEY })]);
      onDone(kind === 'GUEST_REQUEST' && department ? SENT_TO[department] : 'Đã gửi báo cáo sự cố cho bộ phận kỹ thuật.');
    },
  });
  const ready = content.trim().length > 0 && (kind !== 'GUEST_REQUEST' || department !== '') && !send.isPending && !send.isSuccess;
  const noStaff = send.error instanceof ApiError && (send.error.details as { reason?: string } | undefined)?.reason === 'NO_STAFF_ON_SHIFT';
  const fact = (label: string, value: string) => (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900">{value}</dd>
    </div>
  );
  return (
    <Modal
      open
      title="Báo cáo vấn đề"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={send.isPending}>
            Hủy
          </Button>
          <Button onClick={() => send.mutate({})} disabled={!ready} loading={send.isPending} data-testid="quick-report-send">
            Gửi báo cáo
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="quick-report">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-slate-50 px-3 py-2" data-testid="quick-report-facts">
          {fact('Chi nhánh', task.branch.address)}
          {fact('Phòng / khu vực', placeText(task))}
          {fact('Người báo cáo', me?.fullName ?? '—')}
          {fact('Thời gian', 'Lúc bấm “Gửi báo cáo”')}
        </dl>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700">Loại vấn đề</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['FACILITY_ISSUE', 'Sự cố cơ sở vật chất'],
                ['GUEST_REQUEST', 'Khách yêu cầu'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                disabled={send.isPending || createdIssue.current !== null}
                data-testid={`quick-report-kind-${value}`}
                className={`min-h-[3rem] rounded-xl border-2 px-3 text-sm font-semibold ${
                  kind === value ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-white text-slate-700'
                } disabled:opacity-70`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        {kind === 'GUEST_REQUEST' ? (
          <DepartmentPicker value={department} onChange={setDepartment} allowSelf={maySelfClaim(me)} testId="quick-report-department" />
        ) : (
          <p className="text-xs text-slate-500" data-testid="quick-report-facility-route">
            Sự cố cơ sở vật chất được chuyển cho bộ phận kỹ thuật xử lý.
          </p>
        )}
        <SeverityPicker value={severity} onChange={setSeverity} testId="quick-report-severity" />
        <label className="block text-sm font-medium text-slate-700">
          Mô tả
          <textarea
            rows={3}
            maxLength={2000}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={kind === 'GUEST_REQUEST' ? 'Khách cần gì?' : 'Hỏng gì, ở đâu?'}
            data-testid="quick-report-content"
            className="mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-base"
          />
        </label>
        {send.error instanceof ApiError && send.error.code === 'POSSIBLE_DUPLICATE' ? (
          <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950" role="alert" data-testid="quick-report-duplicate">
            <p>{send.error.message}</p>
            <Button variant="secondary" onClick={() => send.mutate({ confirmDuplicate: true })} loading={send.isPending} data-testid="quick-report-confirm-duplicate">
              Vẫn gửi
            </Button>
          </div>
        ) : noStaff ? (
          <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950" role="alert" data-testid="quick-report-no-staff">
            <p>{send.error?.message}</p>
            <p className="text-xs">Chọn bộ phận khác, hoặc lưu để quản lý giao người xử lý sau.</p>
            <Button variant="secondary" onClick={() => send.mutate({ allowUnassigned: true })} loading={send.isPending} data-testid="quick-report-save-unassigned">
              Vẫn lưu, chờ giao
            </Button>
          </div>
        ) : send.isError ? (
          <ErrorAlert>
            {toUserMessage(send.error)}
            {createdIssue.current ? ' Sự cố đã được gửi cho kỹ thuật — bấm “Gửi báo cáo” để ghi lại vào nhật ký.' : ''}
          </ErrorAlert>
        ) : null}
      </div>
    </Modal>
  );
}
