/**
 * Báo cáo charge — the monthly report.
 *
 * Answers one question: "trong tháng này đã charge những khách nào, và tổng bao
 * nhiêu tiền?"
 *
 * THE HEADLINE NUMBER COUNTS SUCCESSFUL CHARGES ONLY. Failed and unprocessed
 * documents are shown beside it — an operator needs to see them — but their
 * amounts are never added in, and the screen says so rather than leaving the
 * reader to infer it.
 *
 * MEMBERSHIP IS BY NGÀY CHARGE, not by when the document was raised. Every
 * total here comes from the server; nothing is recomputed in the browser, which
 * is what makes the XLSX download and this screen incapable of disagreeing.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { CHARGE_STATUS_LABEL, chargeDocumentsApi } from '../api/chargeDocuments';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageState';
import { formatDate, formatDateTime, formatMoney } from '../lib/format';

/** The current month in Asia/Ho_Chi_Minh, as "YYYY-MM". */
function currentMonth(): string {
  const hcm = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return hcm.toISOString().slice(0, 7);
}

function Stat({
  label,
  count,
  amount,
  tone = 'default',
  testId,
}: {
  label: string;
  count: number;
  amount?: number;
  tone?: 'default' | 'primary' | 'danger';
  testId?: string;
}) {
  const toneClass =
    tone === 'primary'
      ? 'border-brand-200 bg-brand-50'
      : tone === 'danger'
        ? 'border-red-200 bg-red-50/60'
        : 'border-slate-200 bg-white';
  return (
    <Card className={`p-5 ${toneClass}`} data-testid={testId}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{count}</p>
      {amount !== undefined ? (
        <p className="mt-1 text-sm font-medium text-slate-700">{formatMoney(amount)}</p>
      ) : null}
    </Card>
  );
}

export function ChargeReportPage() {
  const navigate = useNavigate();
  const [month, setMonth] = useState(currentMonth());

  const report = useQuery({
    queryKey: ['charge-report', month],
    queryFn: () => chargeDocumentsApi.report(month),
  });

  const data = report.data?.report;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Báo cáo charge"
        description="Tổng hợp theo ngày charge trong tháng."
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/app/charge-documents')}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Danh sách
            </Button>
            <a
              href={chargeDocumentsApi.exportUrl(month)}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
              data-testid="charge-export-link"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Xuất XLSX
            </a>
          </>
        }
      />

      <Card className="p-5">
        <label className="block text-sm font-medium text-slate-600">
          Tháng
          <input
            type="month"
            aria-label="Tháng báo cáo"
            className="mt-1 w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
      </Card>

      {report.isError ? <ErrorAlert>{toUserMessage(report.error)}</ErrorAlert> : null}

      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Đã bị charge"
              count={data.totals.chargedCount}
              amount={data.totals.chargedAmount}
              tone="primary"
              testId="stat-charged"
            />
            <Stat
              label="Charge thất bại"
              count={data.totals.failedCount}
              amount={data.totals.failedAmount}
              tone="danger"
              testId="stat-failed"
            />
            <Stat
              label="Chưa xử lý"
              count={data.totals.pendingCount}
              amount={data.totals.pendingAmount}
              testId="stat-pending"
            />
            <Stat label="Tổng số chứng từ" count={data.totals.documentCount} testId="stat-documents" />
          </div>

          <Card className="border-brand-200 bg-brand-50/60 p-5" data-testid="charge-headline">
            <p className="text-xs font-medium uppercase tracking-wide text-brand-700">
              Tổng tiền đã charge
            </p>
            <p className="mt-1 text-3xl font-semibold text-slate-900">
              {formatMoney(data.totals.chargedAmount)}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {data.totals.chargedCount} khách · chỉ tính chứng từ “Đã bị charge”. Không bao gồm
              charge thất bại hoặc chưa xử lý.
            </p>
          </Card>

          <Card className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="charge-report-table">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3">Tên khách</th>
                    <th className="px-4 py-3">Mã đặt phòng</th>
                    <th className="px-4 py-3">Chi nhánh</th>
                    <th className="px-4 py-3">Số tiền</th>
                    <th className="px-4 py-3">Thẻ</th>
                    <th className="px-4 py-3">Check-in</th>
                    <th className="px-4 py-3">Check-out</th>
                    <th className="px-4 py-3">Ngày charge</th>
                    <th className="px-4 py-3">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100">
                      <td className="px-4 py-3 font-medium text-slate-900">{row.guestName}</td>
                      <td className="px-4 py-3 font-mono text-slate-600">{row.bookingCode}</td>
                      <td className="px-4 py-3 text-slate-600">Chi nhánh {row.branch.branchNumber}</td>
                      <td className="px-4 py-3 text-slate-900">{formatMoney(row.amount)}</td>
                      {/* Masked here too — the report never carries a full number. */}
                      <td className="px-4 py-3 font-mono text-slate-500">{row.cardMasked}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(row.checkIn)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(row.checkOut)}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {row.chargedAt ? formatDateTime(row.chargedAt) : '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{CHARGE_STATUS_LABEL[row.status]}</td>
                    </tr>
                  ))}
                  {data.rows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-400">
                        Tháng này chưa có khách nào bị charge.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
