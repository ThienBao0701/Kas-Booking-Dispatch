import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { branchesApi } from '../api/bookings';
import { devTestApi } from '../api/devTest';
import { DEV_TOOLS_KEY, useDevTools } from '../hooks/useDevTools';

/**
 * A development-only bar shown under the top bar when the server's dev tools are
 * enabled. It always shows a clear warning banner, and for the dedicated
 * `reception_test` account it adds a branch switcher. Rendered nothing for
 * ordinary users when the tools are disabled.
 */
export function DevToolsBar() {
  const { user } = useAuth();
  const status = useDevTools(!!user);

  if (!status.data?.enabled) return null;

  return (
    <div className="border-b border-amber-300 bg-amber-50">
      <div className="mx-auto flex max-w-[120rem] flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-amber-800">
          <FlaskConical className="h-4 w-4" aria-hidden="true" />
          CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT
        </p>
        {status.data.isTestReceptionist ? <TestBranchSwitcher activeBranchId={status.data.activeTestBranchId} /> : null}
      </div>
    </div>
  );
}

function TestBranchSwitcher({ activeBranchId }: { activeBranchId: number | null }) {
  const queryClient = useQueryClient();
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), staleTime: 5 * 60_000 });

  const switchBranch = useMutation({
    mutationFn: (branchId: number) => devTestApi.setActiveBranch(branchId),
    onSuccess: async () => {
      // Refresh the dev-tools status and invalidate every branch-scoped query so
      // no stale data from the previous branch remains visible.
      await queryClient.invalidateQueries({ queryKey: DEV_TOOLS_KEY });
      await queryClient.invalidateQueries();
    },
  });

  const options = branches.data?.branches ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-xs font-medium text-amber-800">
        Chi nhánh đang test
        <select
          value={activeBranchId ?? ''}
          disabled={switchBranch.isPending}
          onChange={(e) => switchBranch.mutate(Number(e.target.value))}
          aria-label="Chi nhánh đang test"
          className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-xs text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <option value="" disabled>
            Chọn chi nhánh…
          </option>
          {options.map((b) => (
            <option key={b.id} value={b.id}>
              {b.address}
            </option>
          ))}
        </select>
      </label>
      {switchBranch.isPending ? (
        <span className="flex items-center gap-1 text-xs text-amber-700" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Đang chuyển…
        </span>
      ) : null}
      <span className="w-full text-[0.7rem] text-amber-700 sm:w-auto">
        Đây là tài khoản test. Dữ liệu hiển thị theo chi nhánh đang chọn.
      </span>
    </div>
  );
}
