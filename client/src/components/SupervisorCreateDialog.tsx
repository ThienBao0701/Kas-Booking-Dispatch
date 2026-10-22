/**
 * "+ BÁO CÁO VẤN ĐỀ" FOR A SUPERVISOR — the Admin, a Quản lý lễ tân or a Tổng
 * quản lý lễ tân entering a record FOR ONE BRANCH.
 *
 * THREE DECISIONS, IN ORDER, AND THE FIRST ONE IS NEVER "ALL":
 *   1. one specific branch of the reader's scope — "Tất cả" is a way of READING,
 *      never a place a record can be written to;
 *   2. one of the six categories;
 *   3. the SAME form Reception uses, pointed at that branch.
 *
 * The chosen branch stays on screen above the form. Nothing here is a second
 * form: the payment, request, service-quality, room-service and delivery forms
 * are Reception's own, and "Sự cố cơ sở vật chất" opens Reception's incident
 * dialog (the caller owns it, because it is a dialog of its own). The server
 * checks the branch against the reader's scope and marks the record "Admin tạo".
 */
import { useState } from 'react';
import type { Branch } from '../auth/types';
import { branchLabel } from '../auth/types';
import type { ReportCategory, ReportOptions } from '../api/receptionReports';
import { Modal } from './Modal';
import { Button } from './Button';
import { NewPaymentForm } from './PaymentLedger';
import { DeliveryForm, GuestRequestForm, RoomServiceForm, ServiceQualityForm } from './OperationalForms';
import { TargetBranchBanner } from './IncidentReporting';
import { CATEGORY_MARKERS, CATEGORY_ORDER, PAYMENT_SOURCE_FALLBACK } from '../lib/reportCategories';

export function SupervisorCreateDialog({
  branches,
  options,
  initialBranchId,
  labelOf,
  onClose,
  onCreated,
  onFacility,
}: {
  /** The reader's branches — from the server's scope, never a typed list. */
  branches: Branch[];
  options?: ReportOptions;
  /** The branch the screen is on, when it is one branch: offered first. */
  initialBranchId?: number | null;
  labelOf: (c: ReportCategory) => string;
  onClose: () => void;
  onCreated: (message: string) => void | Promise<void>;
  /** "Sự cố cơ sở vật chất": the caller opens the shared incident dialog for this branch. */
  onFacility: (branchId: number) => void;
}) {
  const [branchId, setBranchId] = useState<number | null>(
    initialBranchId && branches.some((b) => b.id === initialBranchId) ? initialBranchId : null,
  );
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const branch = branches.find((b) => b.id === branchId) ?? null;

  const done = (message: string) => async () => {
    await onCreated(message);
  };

  return (
    <Modal open size="4xl" title="Báo cáo vấn đề" onClose={onClose}>
      <div className="space-y-4" data-testid="supervisor-create">
        {/* 1 — ONE BRANCH. There is deliberately no "Tất cả" here. */}
        <section aria-labelledby="create-step-branch">
          <h3 id="create-step-branch" className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
            1. Chọn chi nhánh
          </h3>
          <select
            aria-label="Chi nhánh nhận bản ghi"
            data-testid="create-branch"
            value={branchId ?? ''}
            onChange={(e) => {
              setBranchId(e.target.value === '' ? null : Number(e.target.value));
              // A form half-filled for one branch must not silently switch to another.
              setCategory(null);
            }}
            className="min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-800 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <option value="">— Chọn một chi nhánh cụ thể —</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {branchLabel(b)}
              </option>
            ))}
          </select>
        </section>

        {branch ? (
          <>
            <TargetBranchBanner label={branchLabel(branch)} />

            {/* 2 — ONE CATEGORY, the six the journal has. */}
            <section aria-labelledby="create-step-category">
              <h3
                id="create-step-category"
                className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600"
              >
                2. Chọn danh mục
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="Danh mục">
                {CATEGORY_ORDER.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={category === c}
                    data-testid={`create-category-${c}`}
                    onClick={() => (c === 'FACILITY_ISSUE' ? onFacility(branch.id) : setCategory(c))}
                    className={`flex min-h-[2.75rem] items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                      category === c
                        ? 'border-brand-600 bg-brand-50 font-semibold text-brand-800'
                        : 'border-line bg-white text-slate-700 hover:border-line-strong hover:bg-slate-50'
                    }`}
                  >
                    <span className="inline-flex h-6 min-w-[1.75rem] items-center justify-center rounded-md bg-slate-100 px-1 text-xs font-bold text-slate-600">
                      {CATEGORY_MARKERS[c]}
                    </span>
                    {labelOf(c)}
                  </button>
                ))}
              </div>
            </section>

            {/* 3 — THE SHARED FORM, for this branch. */}
            {category ? (
              <section aria-labelledby="create-step-form" className="border-t-rule border-line-subtle pt-3">
                <h3
                  id="create-step-form"
                  className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                >
                  3. {labelOf(category)}
                </h3>
                {category === 'PAYMENT' ? (
                  <NewPaymentForm
                    bare
                    branchId={branch.id}
                    methods={options?.paymentMethods}
                    sources={options?.paymentSources ?? PAYMENT_SOURCE_FALLBACK}
                    onCancel={onClose}
                    onCreated={done('Đã ghi nhận giao dịch cho chi nhánh.')}
                  />
                ) : category === 'GUEST_REQUEST' ? (
                  <GuestRequestForm
                    bare
                    branchId={branch.id}
                    onCancel={onClose}
                    onCreated={done('Đã thêm yêu cầu của khách cho chi nhánh.')}
                  />
                ) : category === 'CUSTOMER_COMPLAINT' ? (
                  <ServiceQualityForm
                    bare
                    branchId={branch.id}
                    onCancel={onClose}
                    onCreated={done('Đã ghi nhận vấn đề chất lượng và dịch vụ cho chi nhánh.')}
                  />
                ) : category === 'ROOM_SERVICE' ? (
                  <RoomServiceForm
                    bare
                    branchId={branch.id}
                    options={options}
                    onCancel={onClose}
                    onCreated={done('Đã ghi nhận dịch vụ phòng cho chi nhánh.')}
                  />
                ) : category === 'HOTEL_DELIVERY' ? (
                  <DeliveryForm
                    bare
                    branchId={branch.id}
                    options={options}
                    onCancel={onClose}
                    onCreated={done('Đã ghi nhận giao nhận hàng hóa cho chi nhánh.')}
                  />
                ) : null}
              </section>
            ) : null}
          </>
        ) : (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="create-branch-first">
            Chọn một chi nhánh cụ thể trước khi nhập dữ liệu. Không thể tạo bản ghi cho "Tất cả chi nhánh".
          </p>
        )}

        {branch && !category ? (
          <div className="flex justify-end border-t border-line-subtle pt-3">
            <Button variant="secondary" onClick={onClose}>
              Hủy
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
