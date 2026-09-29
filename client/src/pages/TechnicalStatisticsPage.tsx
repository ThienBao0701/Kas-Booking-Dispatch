/**
 * "THỐNG KÊ" — Bộ phận kỹ thuật's at-a-glance view of the incidents.
 *
 * EVERY FIGURE COMES FROM `/api/issues/statistics`, which counts the incidents
 * and repair attempts that already exist. Nothing is stored for this page and
 * nothing is invented for it: with no incidents the tiles read 0, the charts say
 * there is nothing to chart, and a page that looks empty is the correct answer.
 *
 * TWO DIFFERENT QUESTIONS, LABELLED AS SUCH: the tiles headed "trong kỳ" count
 * incidents REPORTED in the chosen period; "Đang tồn đọng" is everything not
 * finished at any age, because an old open incident is exactly what a period
 * report hides.
 *
 * Plain CSS bars — no charting dependency for six small distributions.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, ClipboardList, RefreshCw, Wrench } from 'lucide-react';
import { issuesApi, type IncidentStatistics } from '../api/issues';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { PageHeader, QueryState } from '../components/PageState';
import { StatCard } from '../components/StatCard';
import { branchOptionLabel } from '../lib/branchTone';
import { formatDate } from '../lib/format';

const PERIODS = [
  { days: 7, label: '7 ngày' },
  { days: 30, label: '30 ngày' },
  { days: 90, label: '90 ngày' },
] as const;

export function TechnicalStatisticsPage() {
  const [days, setDays] = useState<number>(30);
  const stats = useQuery({
    queryKey: ['issues', 'statistics', days],
    queryFn: () => issuesApi.statistics({ days }),
    refetchInterval: 60_000,
  });
  const s = stats.data?.statistics;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Thống kê"
        description="Tổng quan các sự cố khách sạn đã ghi nhận. Số liệu lấy trực tiếp từ dữ liệu sự cố hiện có."
        actions={
          <>
            <div role="group" aria-label="Khoảng thời gian" className="inline-flex overflow-hidden rounded-xl border border-slate-300 bg-white">
              {PERIODS.map((p, i) => (
                <button
                  key={p.days}
                  type="button"
                  aria-pressed={days === p.days}
                  onClick={() => setDays(p.days)}
                  data-testid={`stats-period-${p.days}`}
                  className={`min-h-[2.5rem] px-3.5 text-sm transition-colors focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                    i > 0 ? 'border-l border-slate-300' : ''
                  } ${days === p.days ? 'bg-brand-50 font-semibold text-brand-700' : 'font-medium text-slate-600 hover:bg-slate-50'}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Button variant="secondary" onClick={() => void stats.refetch()} aria-label="Làm mới">
              <RefreshCw className={`h-4 w-4 ${stats.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            </Button>
          </>
        }
      />

      <QueryState isLoading={stats.isLoading} isError={stats.isError} error={stats.error} onRetry={() => void stats.refetch()}>
        {s ? <Body s={s} /> : null}
      </QueryState>
    </div>
  );
}

function Body({ s }: { s: IncidentStatistics }) {
  const range = `${formatDate(s.period.from)} – ${formatDate(s.period.to)}`;
  const empty = s.totals.total === 0;
  return (
    <div className="space-y-5" data-testid="stats-body">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="stats-tiles">
        <StatCard label={`Sự cố trong kỳ (${s.period.days} ngày)`} value={s.totals.total} icon={ClipboardList} />
        <StatCard label="Đang tồn đọng (mọi ngày báo)" value={s.outstanding.total} icon={AlertTriangle} tone={s.outstanding.total > 0 ? 'red' : 'default'} />
        <StatCard label="Đã hoàn thành trong kỳ" value={s.totals.completedCount} icon={CheckCircle2} tone="green" />
        <StatCard label="Cần xử lý lại" value={s.totals.needsReworkCount} icon={Wrench} tone="amber" />
      </div>

      {empty ? (
        <p data-testid="stats-empty" className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-600">
          Chưa có sự cố nào được báo trong kỳ {range}. Biểu đồ sẽ hiện khi có dữ liệu
          {s.outstanding.total > 0 ? `; hiện còn ${s.outstanding.total} sự cố chưa hoàn thành từ trước.` : '.'}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Theo trạng thái" note={`Sự cố báo trong kỳ ${range}`}>
          <Bars
            testId="stats-by-status"
            items={s.byStatus.map((x) => ({ key: x.status, label: x.label, value: x.count }))}
            tone={{ NEW: 'bg-amber-500', IN_PROGRESS: 'bg-blue-500', COMPLETED: 'bg-emerald-500' }}
          />
        </Panel>
        <Panel title="Theo loại sự cố" note="Loại hỏng hóc do lễ tân chọn">
          <Bars testId="stats-by-category" items={s.byCategory.map((x) => ({ key: x.key, label: x.label, value: x.count }))} />
        </Panel>
        <Panel title="Theo khu vực" note="Nơi xảy ra sự cố">
          <Bars testId="stats-by-area" items={s.byArea.map((x) => ({ key: x.key, label: x.label, value: x.count }))} />
        </Panel>
        <Panel title="Khối lượng sửa chữa" note="Các lượt nhận việc trong kỳ">
          <Workload s={s} />
        </Panel>
      </div>

      <Panel title="Theo chi nhánh" note="Tất cả chi nhánh đang hoạt động, kể cả chi nhánh chưa có sự cố">
        <BranchTable s={s} />
      </Panel>

      <Panel title="Xu hướng theo ngày" note="Sự cố mới báo và sự cố hoàn thành mỗi ngày">
        <Trend s={s} />
      </Panel>
    </div>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {note ? <p className="mb-3 text-xs text-slate-500">{note}</p> : <div className="mb-3" />}
      {children}
    </Card>
  );
}

/** Horizontal bars, each with its number printed — the bar is never the only way to read it. */
function Bars({
  items,
  tone,
  testId,
}: {
  items: { key: string; label: string; value: number }[];
  tone?: Record<string, string>;
  testId: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.length === 0 || items.every((i) => i.value === 0)) {
    return <p className="text-sm text-slate-400" data-testid={`${testId}-empty`}>Chưa có dữ liệu.</p>;
  }
  return (
    <ul className="space-y-2" data-testid={testId}>
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-2 text-sm">
          <span className="truncate text-slate-700" title={i.label}>{i.label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <span
              className={`block h-full rounded-full ${tone?.[i.key] ?? 'bg-brand-600'}`}
              style={{ width: `${(i.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right font-semibold tabular-nums text-slate-900">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Workload({ s }: { s: IncidentStatistics }) {
  const w = s.workload;
  if (w.attempts === 0) {
    return <p className="text-sm text-slate-400" data-testid="stats-workload-empty">Chưa có lượt sửa chữa nào trong kỳ.</p>;
  }
  return (
    <div data-testid="stats-workload">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <Fact label="Lượt nhận việc" value={String(w.attempts)} />
        <Fact label="Hoàn thành" value={String(w.completedAttempts)} />
        <Fact label="Không sửa được" value={String(w.cannotRepairAttempts)} />
        <Fact label="Thời gian TB / lượt" value={w.averageLabel ?? '—'} />
      </dl>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="py-1 font-medium">Kỹ thuật viên</th>
            <th className="py-1 text-right font-medium">Lượt</th>
            <th className="py-1 text-right font-medium">Xong</th>
            <th className="py-1 text-right font-medium">Không sửa được</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {w.byTechnician.map((t) => (
            <tr key={t.name}>
              <td className="py-1.5 text-slate-800">{t.name}</td>
              <td className="py-1.5 text-right tabular-nums">{t.attempts}</td>
              <td className="py-1.5 text-right tabular-nums">{t.completed}</td>
              <td className="py-1.5 text-right tabular-nums">{t.cannotRepair}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-base font-semibold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}

function BranchTable({ s }: { s: IncidentStatistics }) {
  const max = Math.max(1, ...s.byBranch.map((b) => b.total));
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm" data-testid="stats-by-branch">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="py-1.5 pr-3 font-medium">Chi nhánh</th>
            <th className="w-1/3 py-1.5 pr-3 font-medium">Phân bố</th>
            <th className="py-1.5 pr-3 text-right font-medium">Tổng</th>
            <th className="py-1.5 pr-3 text-right font-medium">Chưa xong</th>
            <th className="py-1.5 text-right font-medium">Đã xong</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {s.byBranch.map((b) => (
            <tr key={b.branchId}>
              <td className="py-2 pr-3 font-medium text-slate-800">{branchOptionLabel(b)}</td>
              <td className="py-2 pr-3" aria-hidden="true">
                <span className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
                  <span className="bg-blue-500" style={{ width: `${(b.open / max) * 100}%` }} />
                  <span className="bg-emerald-500" style={{ width: `${(b.completed / max) * 100}%` }} />
                </span>
              </td>
              <td className="py-2 pr-3 text-right font-semibold tabular-nums">{b.total}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-blue-700">{b.open}</td>
              <td className="py-2 text-right tabular-nums text-emerald-700">{b.completed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 flex items-center gap-3 text-xs text-slate-500">
        <Legend tone="bg-blue-500" label="Chưa xong" />
        <Legend tone="bg-emerald-500" label="Đã xong" />
      </p>
    </div>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-sm ${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function Trend({ s }: { s: IncidentStatistics }) {
  const max = Math.max(1, ...s.trend.flatMap((d) => [d.reported, d.completed]));
  const active = s.trend.some((d) => d.reported > 0 || d.completed > 0);
  if (!active) {
    return <p className="text-sm text-slate-400" data-testid="stats-trend-empty">Chưa có sự cố phát sinh hoặc hoàn thành trong kỳ.</p>;
  }
  const first = s.trend[0]!;
  const last = s.trend[s.trend.length - 1]!;
  return (
    <div data-testid="stats-trend">
      <div className="flex h-36 items-end gap-px" role="img" aria-label="Biểu đồ số sự cố mới báo và hoàn thành theo ngày">
        {s.trend.map((d) => (
          <div
            key={d.date}
            className="flex h-full flex-1 items-end justify-center gap-px"
            title={`${formatDate(d.date)}: ${d.reported} báo · ${d.completed} hoàn thành`}
          >
            <span className="w-full max-w-[10px] rounded-t bg-brand-600" style={{ height: `${(d.reported / max) * 100}%`, minHeight: d.reported ? 2 : 0 }} />
            <span className="w-full max-w-[10px] rounded-t bg-emerald-500" style={{ height: `${(d.completed / max) * 100}%`, minHeight: d.completed ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{formatDate(first.date)}</span>
        <span>{formatDate(last.date)}</span>
      </div>
      <p className="mt-2 flex items-center gap-3 text-xs text-slate-500">
        <Legend tone="bg-brand-600" label="Mới báo" />
        <Legend tone="bg-emerald-500" label="Hoàn thành" />
        <span className="inline-flex items-center gap-1"><Activity className="h-3 w-3" aria-hidden="true" />Cao nhất: {max}/ngày</span>
      </p>
    </div>
  );
}
