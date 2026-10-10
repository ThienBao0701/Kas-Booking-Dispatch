/**
 * The operational sections of the booking detail — what is left of them.
 *
 * 5.2d deleted three: what the OTA said, the edit history and the activity log.
 * Nobody in the pilot acted on any of them, and a receptionist reading a screen
 * of provenance is a receptionist not reading the reservation. This file keeps
 * a set of assertions that they are GONE, for both roles and for a booking
 * carrying the data that used to fill them — a section that renders "only for
 * admins" is one role check away from coming back.
 *
 * Two behaviours remain pinned. A section with nothing in it is not rendered:
 * empty rows would suggest details were lost when none were ever sent. And
 * request provenance appears only for an Admin — because the server omits the
 * key entirely for a receptionist, that is asserted against the receptionist's
 * real payload shape rather than a client-side flag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import {
  ADMIN_USER,
  EMPTY_OPERATIONAL_BLOCKS,
  RECEPTIONIST_USER,
  installApiMock,
  renderApp,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BASE = {
  id: 'b1',
  status: 'NEW',
  sourcePlatform: 'AGODA',
  verificationStatus: 'NOT_SUBMITTED',
  businessType: 'OTA',
  businessTypeManuallyConfirmed: false,
  hotelName: 'Saigon Hotel',
  branch: { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel', address: '05 Trương Định' },
  branchId: 1,
  customerName: 'Nguyễn Văn A',
  phone: '0901234567',
  bookingCode: 'A-1',
  checkInDate: '2026-08-04',
  checkOutDate: '2026-08-05',
  checkInTime: null,
  checkOutTime: null,
  totalAmount: 1_000_000,
  currency: 'VND',
  paymentStatus: 'PAY_BEFORE',
  specialRequest: null,
  parserVersion: '5.0.0',
  isLastMinute: false,
  rooms: [],
  warnings: [],
  proofs: [],
  createdBy: null,
  sentBy: null,
  completedBy: null,
  reviewedBy: null,
  createdAt: '2026-08-01T02:00:00.000Z',
  updatedAt: '2026-08-01T02:00:00.000Z',
  sentAt: '2026-08-01T02:00:00.000Z',
  completedAt: null,
  completionNote: null,
  reviewedAt: null,
  ...EMPTY_OPERATIONAL_BLOCKS,
};

const IP = '203.0.113.9';
const UA = 'Mozilla/5.0 (KasProbe)';

/**
 * A booking that has been through the Phase 5 workflow.
 *
 * It deliberately still carries the REMOVED blocks — the OTA metadata, an
 * applied correction and a timeline. The server no longer sends them, but a
 * fixture that omits them could not tell a deleted card from a card that
 * simply had no data. Sending them and finding nothing on screen is the
 * assertion.
 */
const RICH = {
  ...BASE,
  ota: {
    paymentType: 'CN',
    // Deliberately not digits: the guest phone contains "1234567", and a
    // substring assertion against that would pass for the wrong reason.
    sourcePropertyId: 'PROPERTY-ZZ9',
    otaBookingStatus: 'Confirmed',
    ratePlanName: 'Standard Rate',
    countryOfResidence: 'Vietnam',
    rawTextSha256: 'a'.repeat(64),
  },
  operational: {
    ...EMPTY_OPERATIONAL_BLOCKS.operational,
    receivedAt: '2026-08-02T03:00:00.000Z',
    receivedBy: { id: 2, fullName: 'Lễ tân Một' },
  },
  corrections: [
    {
      id: 'c1',
      field: 'checkOut',
      oldValue: '2026-08-05',
      newValue: '2026-08-07',
      appliedBy: { id: 1, fullName: 'Quản trị viên' },
      appliedAt: '2026-08-02T04:00:00.000Z',
    },
  ],
  timeline: [
    {
      at: '2026-08-01T02:00:00.000Z',
      type: 'STATUS_NEW',
      description: 'Điều phối tới chi nhánh',
      actor: { id: 1, fullName: 'Quản trị viên' },
    },
    {
      at: '2026-08-02T04:00:00.000Z',
      type: 'AMENDMENT_APPLIED',
      description: 'Áp dụng 1 thay đổi: checkOut',
      actor: { id: 1, fullName: 'Quản trị viên' },
    },
  ],
  requestAudit: {
    parserCommit: 'deadbeef',
    reviewBuildId: 'build-77',
    requests: [
      {
        id: 'req-1',
        correlationId: 'corr-1',
        route: '/admin/ota/amendment/apply',
        ipAddress: IP,
        userAgent: UA,
        sessionId: 'sess-1',
        occurredAt: '2026-08-02T04:00:00.000Z',
      },
    ],
  },
};

/** What the server actually sends a receptionist: no requestAudit key at all. */
function withoutAudit(booking: Record<string, unknown>) {
  const { requestAudit: _dropped, ...rest } = booking;
  return rest;
}

function mount(booking: unknown, user: typeof ADMIN_USER) {
  installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/bookings/b1': () => ({ status: 200, body: { booking } }),
  });
  renderApp('/app/booking/b1');
}

/* ================================================================== */
/* Sections appear only when they hold something                       */
/* ================================================================== */
describe('empty sections stay out of the way', () => {
  it('renders no operational card for a bare booking', async () => {
    mount(BASE, ADMIN_USER);
    // Wait for the detail to load before asserting on what is absent.
    expect(await screen.findByRole('heading', { name: 'Nguyễn Văn A' })).toBeInTheDocument();
    expect(screen.queryByTestId('operational-card')).toBeNull();
  });

  it('renders it once the booking has been through the workflow', async () => {
    mount(RICH, ADMIN_USER);
    expect(await screen.findByTestId('operational-card')).toBeInTheDocument();
  });
});

/* ================================================================== */
/* 5.2d — the three sections that are gone, for everyone               */
/* ================================================================== */
describe('sections removed in 5.2d', () => {
  /**
   * Both roles, one loop. The point of removal is that neither an Admin nor a
   * receptionist can reach these; a test that only checked reception would pass
   * just as well against a role check, which is what this phase replaced.
   */
  for (const [role, user] of [
    ['admin', ADMIN_USER],
    ['reception', RECEPTIONIST_USER],
  ] as const) {
    it(`shows ${role} no OTA information section`, async () => {
      mount(user === ADMIN_USER ? RICH : withoutAudit(RICH), user);
      expect(await screen.findByRole('heading', { name: 'Nguyễn Văn A' })).toBeInTheDocument();
      expect(screen.queryByTestId('ota-metadata-card')).toBeNull();
      // Not merely unlabelled — the values themselves are nowhere on the page.
      expect(document.body.textContent).not.toContain('Standard Rate');
      expect(document.body.textContent).not.toContain('PROPERTY-ZZ9');
      expect(document.body.textContent).not.toContain('Thông tin từ OTA');
    });

    it(`shows ${role} no edit history`, async () => {
      mount(user === ADMIN_USER ? RICH : withoutAudit(RICH), user);
      expect(await screen.findByRole('heading', { name: 'Nguyễn Văn A' })).toBeInTheDocument();
      expect(screen.queryByTestId('corrections-card')).toBeNull();
      expect(screen.queryByTestId('correction-row')).toBeNull();
      expect(document.body.textContent).not.toContain('Lịch sử chỉnh sửa');
    });

    it(`shows ${role} no activity log`, async () => {
      mount(user === ADMIN_USER ? RICH : withoutAudit(RICH), user);
      expect(await screen.findByRole('heading', { name: 'Nguyễn Văn A' })).toBeInTheDocument();
      expect(screen.queryByTestId('timeline-card')).toBeNull();
      expect(screen.queryByTestId('timeline-event')).toBeNull();
      expect(document.body.textContent).not.toContain('Điều phối tới chi nhánh');
      expect(document.body.textContent).not.toContain('Nhật ký');
    });
  }
});

/* ================================================================== */
/* Content                                                             */
/* ================================================================== */
describe('what the sections show', () => {
  it('names who received the booking and when', async () => {
    mount(RICH, ADMIN_USER);
    const card = await screen.findByTestId('operational-card');
    expect(card).toHaveTextContent('Đã nhận đơn');
    expect(card).toHaveTextContent('Lễ tân Một');
  });
});

/* ================================================================== */
/* Request provenance                                                  */
/* ================================================================== */
describe('request provenance', () => {
  it('shows an Admin the build identity and the request rows', async () => {
    mount(RICH, ADMIN_USER);
    const audit = await screen.findByTestId('request-audit');
    expect(audit).toHaveTextContent('deadbeef');
    expect(audit).toHaveTextContent('build-77');
    expect(screen.getByTestId('request-audit-row')).toHaveTextContent(IP);
  });

  it('shows a receptionist nothing of it, and no IP anywhere on the page', async () => {
    mount(withoutAudit(RICH), RECEPTIONIST_USER);
    // The reservation still renders; since the 5.2 pilot pack the audit-facing
    // sections do not, so the booking itself is what proves the page loaded.
    expect(await screen.findByRole('heading', { name: 'Nguyễn Văn A' })).toBeInTheDocument();
    expect(screen.queryByTestId('request-audit')).toBeNull();
    expect(screen.queryByTestId('corrections-card')).toBeNull();
    expect(document.body.textContent).not.toContain(IP);
    expect(document.body.textContent).not.toContain(UA);
    expect(document.body.textContent).not.toContain('sess-1');
    expect(document.body.textContent).not.toContain('corr-1');
  });
});
