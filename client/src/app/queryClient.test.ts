/**
 * The shared React Query client's global behaviour.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * `renderApp()` in the test harness builds its OWN QueryClient, so every other
 * client test exercises a throwaway instance and none of them ever touches the
 * one `main.tsx` actually mounts. Two things live only on the real instance —
 * the retry policy and the mutation-cache error handler — and until this file
 * they had no coverage whatsoever: a change that broke either would have shipped
 * with 825 green tests.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. A mutation refused with SHIFT_CHECK_IN_REQUIRED re-reads the current
 *      shift, which is what makes the picker appear immediately instead of up to
 *      sixty seconds later when the poll next runs.
 *   2. It does that for EVERY mutation, because the handler is on the cache and
 *      not on individual call sites — so proof submission, a handover and a
 *      handover note all get it without any of them remembering to.
 *   3. It fires for nothing else. Invalidating the shift on an unrelated failure
 *      would put the application into a refetch loop on every validation error.
 *   4. An ApiError is never retried and a transient failure is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '../api/errors';
import { SHIFT_SESSION_KEY } from '../hooks/useShiftSession';
import { queryClient } from './queryClient';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Runs a mutation through the REAL client and lets it fail.
 *
 * Built straight off the mutation cache rather than through a component: the
 * handler under test is the cache's, so this exercises it without a render tree
 * and without the harness's substitute client getting in the way.
 */
async function failMutationWith(error: unknown): Promise<void> {
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationFn: () => Promise.reject(error),
    retry: false,
  });
  // The rejection is expected; what is being asserted is the side effect.
  await mutation.execute(undefined).catch(() => undefined);
}

describe('a mutation refused for want of a shift', () => {
  it('re-reads the current shift so the picker can appear at once', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();

    await failMutationWith(
      new ApiError(
        'SHIFT_CHECK_IN_REQUIRED',
        'Vui lòng chọn ca làm việc trước khi tạo đơn.',
        422,
      ),
    );

    expect(invalidate).toHaveBeenCalledWith({ queryKey: SHIFT_SESSION_KEY });
  });

  /**
   * THE HANDLER IS ON THE CACHE, NOT ON A CALL SITE.
   *
   * That is the whole reason it is here: proof submission, "Đổi ca" and a
   * handover note are three different mutations in three different files, and
   * every shift-gated write the application gains later is a fourth. None of
   * them has to remember.
   */
  it('does so for any mutation, not one particular call site', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const refusal = new ApiError('SHIFT_CHECK_IN_REQUIRED', 'Chưa chọn ca.', 422);

    await failMutationWith(refusal);
    await failMutationWith(refusal);

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('is not confused by the message — it keys off the CODE', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    // The same Vietnamese sentence under a different code must NOT trigger it.
    await failMutationWith(
      new ApiError('VALIDATION_ERROR', 'Vui lòng chọn ca làm việc trước khi tạo đơn.', 422),
    );
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('every other failure is left alone', () => {
  it('does not touch the shift on an unrelated ApiError', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    for (const error of [
      new ApiError('VALIDATION_ERROR', 'Thiếu trường.', 422),
      new ApiError('CONFLICT', 'Đã gửi trước đó.', 409),
      new ApiError('FORBIDDEN', 'Không có quyền.', 403),
      new ApiError('BRANCH_ACCESS_DENIED', 'Sai chi nhánh.', 403),
    ]) {
      await failMutationWith(error);
    }
    // Invalidating the shift on an ordinary validation error would put the app
    // into a refetch on every mis-typed form.
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not touch the shift on a network failure or a plain Error', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    await failMutationWith(new NetworkError('Mất kết nối.'));
    await failMutationWith(new Error('boom'));
    await failMutationWith('a string, not an error at all');
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('the retry policy', () => {
  const retry = queryClient.getDefaultOptions().queries?.retry as
    | ((failureCount: number, error: Error) => boolean)
    | undefined;

  it('never retries an ApiError — the server has given its answer', () => {
    expect(retry).toBeTypeOf('function');
    expect(retry!(0, new ApiError('FORBIDDEN', 'Không có quyền.', 403))).toBe(false);
    expect(retry!(0, new ApiError('VALIDATION_ERROR', 'Thiếu trường.', 422))).toBe(false);
  });

  it('retries a transient failure a couple of times, then stops', () => {
    const transient = new NetworkError('Mất kết nối.');
    expect(retry!(0, transient)).toBe(true);
    expect(retry!(1, transient)).toBe(true);
    expect(retry!(2, transient)).toBe(false);
  });

  it('never retries a mutation — a repeated write is not a safe guess', () => {
    expect(queryClient.getDefaultOptions().mutations?.retry).toBe(false);
  });
});
