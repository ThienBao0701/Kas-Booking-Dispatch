import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarClock, CheckCircle2, Clock, Flame, Wrench } from 'lucide-react';
import { dashboardApi } from '../api/bookings';
import { Card } from '../components/Card';
import { StatCard } from '../components/StatCard';
import { DateRangeField, type DateRangeValue } from '../components/DateRangeField';
import { PageHeader, QueryState } from '../components/PageState';
import { hcmToday } from '../lib/format';

const POLL_MS = 30_000;

/**
 * Admin dashboard. Numbers come from the single backend summary endpoint
 * (`GET /api/admin/dashboard/summary`, computed in the property timezone), and
 * the UI links each count through to the matching filtered list.
 *
 * EVERY FIGURE DESCRIBES ONE POPULATION: the orders DISPATCHED inside the
 * selected scope. The server counts them all from a single `sentAt` window, so
 * the cards, the branch rows and the total agree by construction rather than by
 * coincidence — see `adminDashboard.ts`.
 */
export function DashboardPage() {
  /*
    THE SELECTED SCOPE IS SENT TO THE SERVER, not applied to a loaded payload.

    Every figure on this page is a `count(*)` the database runs for that scope,
    so picking the 9th shows the 9th — a client-side filter over a "today"
    response could only ever show today with rows hidden.

    `from === to` is a single day, which is what this page opens on. The range is
    inclusive of both ends.
  */
  const [range, setRange] = useState<DateRangeValue>(() => ({ from: hcmToday(), to: hcmToday() }));

  /*
    A CLEARED END COLLAPSES ONTO THE OTHER ONE. Never onto today.

    A native date input emits '' when cleared, and an unbounded summary is not a
    question this page asks — so a blank end has to resolve to something. The
    obvious "fall back to today" is wrong, and wrong in a way that undoes the
    control's whole purpose: with the end sitting on a past day, clearing the
    START would produce from=today, to=<past day>. That is the inverted range
    `DateRangeField` makes unreachable in the UI, handed to the server anyway,
    which answers 422 — and the operator, who only pressed Delete in a date box,
    loses every card on the page to an error.

    Each end therefore falls back to the OTHER end, and only to today when both
    are blank. Clearing one end means "just the remaining day", which is
    coherent, is never inverted, and is what the boxes on screen actually say.
  */
  const from = range.from || range.to || hcmToday();
  const to = range.to || range.from || hcmToday();
  const isSingleDay = from === to;
  // Live only while the scope still contains today; a closed past period
  // re-fetches numbers that cannot change.
  const includesToday = from <= hcmToday() && to >= hcmToday();

  const query = useQuery({
    queryKey: ['dashboard', 'summary', from, to],
    queryFn: () =>
      // A single day goes out as `date`, keeping the original request shape for
      // the view this page spends almost all of its time in.
      isSingleDay ? dashboardApi.summary({ date: from }) : dashboardApi.summary({ from, to }),
    refetchInterval: includesToday ? POLL_MS : false,
  });

  const totals = query.data?.totals;
  const issues = query.data?.issues;
  /*
    The issues card widened with everything else, so its label must say which
    window it means. "trong ngày" on a six-day scope is a caption that quietly
    contradicts its own number.
  */
  const issueScopeLabel = isSingleDay ? 'Sự cố trong ngày' : 'Sự cố trong kỳ';
  const branches = [...(query.data?.branches ?? [])].sort(
    (a, b) =>
      b.lastMinute - a.lastMinute ||
      b.waiting - a.waiting ||
      a.branch.address.localeCompare(b.branch.address),
  );

  return (
    <div>
      <PageHeader
        title="Tổng quan"
        /*
          The resolved scope, stated in words. The boxes can be blank — clearing
          one is a normal thing to do mid-edit — and a page of counters above two
          empty inputs otherwise says nothing about which period it is counting.
        */
        description={
          isSingleDay
            ? `Đơn đã gửi ngày ${from} (giờ Việt Nam).`
            : `Đơn đã gửi từ ${from} đến ${to} (giờ Việt Nam).`
        }
        actions={
          <div className="flex items-end gap-2">
            {/*
              One control, not two inputs: the period is a single thing an
              operator picks, and the shared field owns the rules that keep it
              coherent (see `DateRangeField`). `max` is today — the dashboard
              counts orders already dispatched, so a future scope is empty by
              definition and offering it only invites a blank page.
            */}
            <DateRangeField
              legend="Khoảng thời gian"
              value={range}
              onChange={setRange}
              max={hcmToday()}
              testId="dashboard-range"
            />
            {/*
              Keyed on the STATE, not the resolved scope: with a box cleared the
              resolved scope can still be today while the control shows blank, and
              hiding the way back at exactly that moment is how an operator gets
              stuck looking at a page they cannot explain.
            */}
            {!(range.from === hcmToday() && range.to === hcmToday()) ? (
              <button
                type="button"
                onClick={() => setRange({ from: hcmToday(), to: hcmToday() })}
                className="min-h-[2.75rem] flex-shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                Hôm nay
              </button>
            ) : null}
          </div>
        }
      />

      <QueryState
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link to="/app/waiting" className="focus-visible:outline-none">
            <StatCard label="Chờ chi nhánh tạo" value={totals?.waiting ?? 0} icon={Clock} tone="amber" />
          </Link>
          <Link to="/app/completed" className="focus-visible:outline-none">
            <StatCard label="Đã xác nhận" value={totals?.confirmedToday ?? 0} icon={CheckCircle2} tone="green" />
          </Link>
          <StatCard label="LAST MINUTE" value={totals?.lastMinute ?? 0} icon={Flame} tone="red" />
          <StatCard label="Tổng đơn gửi" value={totals?.sentToday ?? 0} icon={CalendarClock} />

          {/*
            Issues REPORTED in the selected scope. Scoped like every other figure
            here — on `createdAt`, the only date an issue has — while the sidebar
            badge still carries the running open total, so the backlog signal is
            not lost from the application.
          */}
          <Link
            to="/app/reports?category=FACILITY_ISSUE"
            className="focus-visible:outline-none"
            aria-label={`${issueScopeLabel}: ${issues?.reported ?? 0}`}
          >
            <Card className={`flex items-center gap-4 p-5 ${(issues?.stillOpen ?? 0) > 0 ? 'border-red-200' : ''}`}>
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                <Wrench className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-semibold text-slate-900">{issues?.reported ?? 0}</p>
                <p className="truncate text-sm text-slate-500">{issueScopeLabel}</p>
                <p className="truncate text-xs text-slate-400">{issues?.stillOpen ?? 0} chưa xử lý</p>
              </div>
            </Card>
          </Link>
        </div>

        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Theo chi nhánh</h2>
          {branches.length === 0 ? (
            <p className="text-sm text-slate-400">Chưa có chi nhánh nào.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {branches.map(({ branch, waiting, confirmedToday, lastMinute, sent }) => (
                <Card key={branch.id} className={`p-4 ${lastMinute > 0 ? 'border-red-200' : ''}`}>
                  <p className="text-sm font-semibold text-slate-900">{branch.address}</p>
                  <p className="truncate text-xs text-slate-500">{branch.hotelName}</p>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {/*
                      This branch's share of "Tổng đơn gửi". Shown first because
                      it is the population the other three describe, and because
                      these rows summing to the card above is the thing an
                      operator can now check by eye.
                    */}
                    <span className="text-slate-600">
                      <strong>{sent}</strong> đã gửi
                    </span>
                    <Link
                      to={`/app/waiting?branchId=${branch.id}`}
                      className="text-amber-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    >
                      <strong>{waiting}</strong> chờ tạo
                    </Link>
                    <Link
                      to={`/app/completed?branchId=${branch.id}`}
                      className="text-green-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600"
                    >
                      <strong>{confirmedToday}</strong> đã xác nhận
                    </Link>
                    {lastMinute > 0 ? (
                      <Link
                        to={`/app/waiting?branchId=${branch.id}`}
                        className="font-semibold text-red-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                      >
                        <strong>{lastMinute}</strong> LAST MINUTE
                      </Link>
                    ) : null}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </QueryState>

    </div>
  );
}
