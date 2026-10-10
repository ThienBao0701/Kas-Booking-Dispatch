/**
 * The alternate-name ("tên gọi khác") box in the room-class draft editor.
 *
 * THE BUG THIS PINS: the box committed only on Enter, while the display name and
 * the PMS code beside it committed on blur. An Admin who typed an alternate name
 * and then clicked "Kích hoạt cập nhật" never pressed Enter, so the text stayed
 * in local React state and was thrown away — the field looked accepted and the
 * alias silently never existed. Nothing was wrong with the request, the service
 * or the schema; the value was simply never sent.
 *
 * Blur is the case that matters, because clicking any button blurs the input
 * first. Enter is covered too so the two paths cannot drift apart again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RoomClassManager } from './RoomClassManager';
import { jsonResponse } from '../test/utils';

const BRANCH_ID = 1;
const CLASS_ID = 'rc1';
const DRAFT_ID = 'draft1';

/** POST bodies sent to the alias endpoint, in order. */
let aliasPosts: string[] = [];

function roomClass(aliases: string[]) {
  return {
    id: CLASS_ID,
    stableKey: 'deluxe',
    displayName: 'Deluxe',
    normalizedName: 'deluxe',
    pmsCode: 'DEL',
    active: true,
    sortOrder: 0,
    updatedAt: '2026-08-11T00:00:00.000Z',
    aliases: aliases.map((a, i) => ({ id: `a${i}`, alias: a, source: 'ADMIN', active: true })),
  };
}

function version(status: string, aliases: string[]) {
  return {
    id: status === 'DRAFT' ? DRAFT_ID : 'active1',
    branchId: BRANCH_ID,
    versionNumber: status === 'DRAFT' ? 2 : 1,
    status,
    changeReason: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    activatedAt: null,
    archivedAt: null,
    createdBy: null,
    activatedBy: null,
    roomClasses: [roomClass(aliases)],
  };
}

/** Serves an ACTIVE mapping plus an open DRAFT, and records alias POSTs. */
function mount(existingAliases: string[] = []) {
  let aliases = [...existingAliases];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const href = String(url);
      const method = (init.method ?? 'GET').toUpperCase();

      if (href.includes('/aliases') && method === 'POST') {
        aliasPosts.push(String(init.body));
        aliases = [...aliases, JSON.parse(String(init.body)).alias];
        return jsonResponse(201, { draft: version('DRAFT', aliases) });
      }
      if (href.includes('/room-mapping/versions')) {
        return jsonResponse(200, { versions: [] });
      }
      if (href.includes('/room-mapping')) {
        return jsonResponse(200, {
          active: version('ACTIVE', existingAliases),
          draft: version('DRAFT', aliases),
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: href } });
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RoomClassManager branchId={BRANCH_ID} branchLabel="Chi nhánh 1" onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  aliasPosts = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('adding an alternate room-class name', () => {
  it('SAVES ON BLUR — the case that was silently dropped', async () => {
    mount();
    const input = await screen.findByTestId(`room-class-alias-input-${CLASS_ID}`);

    await userEvent.type(input, 'Phòng Đặc Biệt');
    // Clicking anything blurs the box first; this is exactly what pressing
    // "Kích hoạt cập nhật" does.
    await userEvent.tab();

    await waitFor(() => expect(aliasPosts).toHaveLength(1));
    expect(aliasPosts[0]).toContain('Phòng Đặc Biệt');
  });

  it('still saves on Enter', async () => {
    mount();
    const input = await screen.findByTestId(`room-class-alias-input-${CLASS_ID}`);

    await userEvent.type(input, 'Tên Khác{Enter}');

    await waitFor(() => expect(aliasPosts).toHaveLength(1));
    expect(aliasPosts[0]).toContain('Tên Khác');
  });

  it('does not send twice when Enter is followed by blur', async () => {
    mount();
    const input = await screen.findByTestId(`room-class-alias-input-${CLASS_ID}`);

    await userEvent.type(input, 'Một Lần{Enter}');
    await waitFor(() => expect(aliasPosts).toHaveLength(1));
    await userEvent.tab();

    // The box is cleared on success, so the blur has nothing left to send.
    await waitFor(() => expect(aliasPosts).toHaveLength(1));
  });

  it('sends nothing when the box is left empty', async () => {
    mount();
    const input = await screen.findByTestId(`room-class-alias-input-${CLASS_ID}`);

    await userEvent.click(input);
    await userEvent.tab();

    expect(aliasPosts).toHaveLength(0);
  });

  it('keeps an existing alternate name visible while adding another', async () => {
    mount(['Tên Cũ']);
    // Appears in both the live table above and the draft editor below, so the
    // assertion counts rather than expecting a single node.
    await waitFor(() => expect(screen.getAllByText('Tên Cũ').length).toBeGreaterThan(0));

    const input = screen.getByTestId(`room-class-alias-input-${CLASS_ID}`);
    await userEvent.type(input, 'Tên Mới');
    await userEvent.tab();

    await waitFor(() => expect(aliasPosts).toHaveLength(1));
    // The first one is still on screen after the refetch.
    expect(screen.getAllByText('Tên Cũ').length).toBeGreaterThan(0);
  });

  it('leaves the PMS code alone', async () => {
    mount();
    const input = await screen.findByTestId(`room-class-alias-input-${CLASS_ID}`);
    await userEvent.type(input, 'Không Đụng Mã');
    await userEvent.tab();

    await waitFor(() => expect(aliasPosts).toHaveLength(1));
    expect(screen.getByTestId(`room-class-code-${CLASS_ID}`)).toHaveValue('DEL');
  });
});
