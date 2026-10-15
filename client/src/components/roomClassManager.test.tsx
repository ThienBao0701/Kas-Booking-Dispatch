import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RoomClassManager } from './RoomClassManager';
import { installApiMock } from '../test/utils';
import type { RoomMappingVersionView } from '../api/roomMapping';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function roomClass(over: Partial<RoomMappingVersionView['roomClasses'][number]> = {}) {
  return {
    id: 'rc1',
    stableKey: 'standard',
    displayName: 'Standard',
    normalizedName: 'standard',
    pmsCode: 'STAN',
    active: true,
    sortOrder: 0,
    aliases: [{ id: 'a1', alias: 'STANDARD', source: 'SEED' as const, active: true }],
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function version(over: Partial<RoomMappingVersionView> = {}): RoomMappingVersionView {
  return {
    id: 'v1',
    branchId: 2,
    versionNumber: 1,
    status: 'ACTIVE',
    changeReason: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    activatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    createdBy: null,
    activatedBy: null,
    roomClasses: [
      roomClass(),
      roomClass({ id: 'rc2', stableKey: 'premium', displayName: 'Premium', normalizedName: 'premium', pmsCode: 'LUXDEL', sortOrder: 1, aliases: [] }),
    ],
    ...over,
  };
}

function renderManager(routes: Record<string, (init: RequestInit) => { status: number; body?: unknown }>) {
  const fetchMock = installApiMock(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RoomClassManager branchId={2} branchLabel="Chi nhánh 2 — 260 Lý Tự Trọng" onClose={() => {}} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

const MAPPING_URL = '/api/admin/branches/2/room-mapping';

describe('RoomClassManager', () => {
  it('H1. renders the branch\'s own room classes with their PMS codes and aliases', async () => {
    renderManager({
      [`GET ${MAPPING_URL}`]: () => ({ status: 200, body: { active: version(), draft: null } }),
    });

    expect(await screen.findByText('Đang áp dụng — phiên bản 1')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /Hạng phòng đang áp dụng/ });
    expect(within(table).getByText('Standard')).toBeInTheDocument();
    expect(within(table).getByText('STAN')).toBeInTheDocument();
    expect(within(table).getByText('Premium')).toBeInTheDocument();
    expect(within(table).getByText('LUXDEL')).toBeInTheDocument();
    expect(within(table).getByText('STANDARD')).toBeInTheDocument();
  });

  it('H2. creating a draft leaves the active table on screen and unchanged', async () => {
    let created = false;
    renderManager({
      [`GET ${MAPPING_URL}`]: () => ({
        status: 200,
        body: {
          active: version(),
          draft: created ? version({ id: 'v2', versionNumber: 2, status: 'DRAFT', activatedAt: null }) : null,
        },
      }),
      [`POST ${MAPPING_URL}/drafts`]: () => {
        created = true;
        return { status: 201, body: { draft: version({ id: 'v2', versionNumber: 2, status: 'DRAFT' }) } };
      },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Tạo bản cập nhật' }));

    expect(await screen.findByText('Bản nháp — phiên bản 2')).toBeInTheDocument();
    // The live mapping is still displayed, untouched.
    expect(screen.getByText('Đang áp dụng — phiên bản 1')).toBeInTheDocument();
    expect(screen.getByText(/Bản nháp không ảnh hưởng tới hoạt động hiện tại/)).toBeInTheDocument();
  });

  it('H3. validation problems are shown to the operator', async () => {
    renderManager({
      [`GET ${MAPPING_URL}`]: () => ({
        status: 200,
        body: { active: version(), draft: version({ id: 'v2', versionNumber: 2, status: 'DRAFT' }) },
      }),
      [`POST ${MAPPING_URL}/drafts/v2/validate`]: () => ({
        status: 200,
        body: {
          ok: false,
          activeClassCount: 0,
          problems: [{ code: 'EMPTY_MAPPING', message: 'Không thể kích hoạt cấu hình không có hạng phòng nào.' }],
        },
      }),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Kiểm tra/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể kích hoạt cấu hình không có hạng phòng nào.');
  });

  it('H4. the activation dialog explains that existing bookings keep their code', async () => {
    renderManager({
      [`GET ${MAPPING_URL}`]: () => ({
        status: 200,
        body: {
          active: version(),
          draft: version({
            id: 'v2',
            versionNumber: 2,
            status: 'DRAFT',
            roomClasses: [
              roomClass(),
              roomClass({ id: 'rc2', stableKey: 'premium', displayName: 'Premium', normalizedName: 'premium', pmsCode: 'PREMIUM_NEW', sortOrder: 1, aliases: [] }),
            ],
          }),
        },
      }),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Kích hoạt cập nhật' }));

    const dialog = await screen.findByRole('dialog', { name: 'Kích hoạt cấu hình hạng phòng mới' });
    expect(within(dialog).getByText(/GIỮ NGUYÊN mã phòng cũ/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Chỉ đơn tạo mới sau khi kích hoạt mới dùng cấu hình mới/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Ghi chú đã tạo trước đó không bị viết lại/)).toBeInTheDocument();
    // The change summary shows old → new.
    expect(within(dialog).getByText(/Premium \(LUXDEL\) → Premium \(PREMIUM_NEW\)/)).toBeInTheDocument();
  });

  it('H5. an activation conflict from the server is surfaced, not swallowed', async () => {
    renderManager({
      [`GET ${MAPPING_URL}`]: () => ({
        status: 200,
        body: { active: version(), draft: version({ id: 'v2', versionNumber: 2, status: 'DRAFT' }) },
      }),
      [`POST ${MAPPING_URL}/drafts/v2/activate`]: () => ({
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'Cấu hình đã được người khác cập nhật trong lúc bạn chỉnh sửa. Hãy xem lại thay đổi mới nhất rồi thử lại.',
          },
        },
      }),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Kích hoạt cập nhật' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kích hoạt cấu hình hạng phòng mới' });
    await user.click(within(dialog).getByRole('button', { name: 'Kích hoạt' }));

    expect(await screen.findByText(/người khác cập nhật/)).toBeInTheDocument();
  });

  it('H6. a branch with no mapping is called out rather than shown as empty', async () => {
    renderManager({
      [`GET ${MAPPING_URL}`]: () => ({ status: 200, body: { active: null, draft: null } }),
    });

    expect(await screen.findByText(/chưa có cấu hình hạng phòng/)).toBeInTheDocument();
  });
});
