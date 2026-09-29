import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { App } from '../app/App';
import type { AuthUser } from '../auth/types';

export const ADMIN_USER: AuthUser = {
  id: 1,
  username: 'admin',
  fullName: 'Quản trị viên',
  role: 'ADMIN',
  branch: null,
  active: true,
  mustChangePassword: false,
};

/** Bộ phận đặt phòng: global, so no branch — exactly like an admin's shape. */
export const BOOKING_DEPARTMENT_USER: AuthUser = {
  id: 3,
  username: 'datphong',
  fullName: 'Bộ phận đặt phòng',
  role: 'BOOKING_DEPARTMENT',
  branch: null,
  active: true,
  mustChangePassword: false,
};

/** Bộ phận kỹ thuật: global, so no branch — it works all eight properties. */
export const TECHNICAL_USER: AuthUser = {
  id: 4,
  username: 'kythuat',
  fullName: 'Kỹ thuật viên trực',
  role: 'TECHNICAL',
  branch: null,
  active: true,
  mustChangePassword: false,
};

/** Quản lý kỹ thuật — global like the technician; judges finished repairs. */
export const TECHNICAL_MANAGER_USER: AuthUser = {
  id: 5,
  username: 'quanlykythuat',
  fullName: 'Quản lý Hùng',
  role: 'TECHNICAL_MANAGER',
  branch: null,
  active: true,
  mustChangePassword: false,
};

/** Bộ phận buồng phòng: bound to ONE branch like a receptionist, but with its own two screens. */
export const HOUSEKEEPING_USER: AuthUser = {
  id: 6,
  username: 'buongphong',
  fullName: 'Buồng phòng Một',
  role: 'HOUSEKEEPING',
  branch: {
    id: 1,
    code: 'TRUONG_DINH_05',
    hotelName: 'Saigon Hotel & Ben Thanh',
    address: '05 Trương Định',
  },
  active: true,
  mustChangePassword: false,
};

export const RECEPTIONIST_USER: AuthUser = {
  id: 2,
  username: 'letan',
  fullName: 'Lễ tân Một',
  role: 'RECEPTIONIST',
  branch: {
    id: 1,
    code: 'TRUONG_DINH_05',
    hotelName: 'Saigon Hotel & Ben Thanh',
    address: '05 Trương Định',
  },
  active: true,
  mustChangePassword: false,
};

/** Builds a JSON Response like the backend returns. */
/**
 * The Phase 5 operational blocks in their empty state.
 *
 * The detail endpoint ALWAYS sends these keys, so a fixture that omits them
 * describes a response the server cannot produce. Spread this into booking
 * fixtures rather than teaching the components to tolerate a shape that only
 * exists in tests.
 *
 * `ota` carries ONE field since 5.2d. The metadata card that displayed the
 * other eleven is gone, and the serializer stopped sending them.
 */
export const EMPTY_OPERATIONAL_BLOCKS = {
  ota: {
    paymentType: null,
  },
  operational: {
    receivedAt: null,
    receivedBy: null,
    actualCheckInAt: null,
    checkedInBy: null,
    actualCheckOutAt: null,
    checkedOutBy: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
  },
};

export function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type MockHandler = (init: RequestInit) => { status: number; body?: unknown };

/**
 * Installs a fetch mock that routes `"METHOD /api/path"` to a handler. Any
 * unmatched request resolves to a 404 so tests fail loudly on a missing mock.
 */
export function installApiMock(routes: Record<string, MockHandler>) {
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${String(url)}`;
    const handler = routes[key];
    if (!handler) {
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: `no mock for ${key}` } });
    }
    const { status, body } = handler(init);
    return jsonResponse(status, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Renders the whole app inside a MemoryRouter at the given path. */
export function renderApp(initialPath = '/') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
