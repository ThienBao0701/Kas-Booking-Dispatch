import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { branchesApi } from '../api/bookings';
import { useAuth } from '../auth/AuthProvider';
import { branchLabel, type Branch } from '../auth/types';
import { BranchPicker } from '../components/ReportFilter';
import { hotelName } from '../lib/hkDisplay';
import type { BranchChoice } from '../lib/reportFilter';

/* ------------------------------------------------------------------ *
 * The manager's branch (fixed) or the Admin's choice
 * ------------------------------------------------------------------ */

export function useScope(allowAll: boolean) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), enabled: isAdmin });
  const [choice, setChoice] = useState<BranchChoice>(allowAll ? 'ALL' : null);
  const list = branches.data?.branches ?? [];
  const branchId = isAdmin ? (typeof choice === 'number' ? choice : undefined) : (user?.branch?.id ?? undefined);
  const ready = !isAdmin || choice !== null;
  const chosen = typeof choice === 'number' ? list.find((b) => b.id === choice) : undefined;
  const label = !isAdmin
    ? user?.branch
      ? hotelName(user.branch as Branch, false)
      : '—'
    : choice === 'ALL'
      ? 'Tất cả chi nhánh'
      : chosen
        ? branchLabel(chosen)
        : 'Chưa chọn';
  const picker: ReactNode = isAdmin ? (
    <div className="w-full min-w-0 sm:w-72">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Chi nhánh</p>
      <BranchPicker value={choice} onChange={setChoice} branches={list} allowAll={allowAll} />
    </div>
  ) : null;
  return { isAdmin, branchId, ready, picker, label };
}

