import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AgodaPartnerCard } from './AgodaPartnerCard';
import type { AgodaPartnerExtras } from '../api/bookings';

const EXTRAS: AgodaPartnerExtras = {
  bookingId: '1753026280',
  sourceHotelName: 'KAS Sonata Luxury Hotel',
  branchAddress: '40-42 Bùi Thị Xuân',
  branchCode: 'BUI_THI_XUAN_40',
  branchId: 6,
  customerFullName: 'TEST CUSTOMER',
  checkIn: '2026-07-27',
  checkOut: '2026-07-29',
  nights: 2,
  roomTypeOriginal: 'Standard (0)',
  roomCode: 'STAN',
  roomTypeKnown: true,
  roomQuantity: 1,
  occupancy: '2 Adults',
  extraBeds: 0,
  netRate: 1_016_710,
  referenceSellRate: 1_680_000,
  payment: 'PREPAID',
  ratePlan: 'Standard Rate - Non Refundable',
  cancellationPolicy: 'Non-refundable',
  countryOfResidence: 'Vietnam',
  nightlyRates: [
    { stayDate: '2026-07-27', amount: 508_355 },
    { stayDate: '2026-07-28', amount: 508_355 },
  ],
  totalDebtAmount: 1_016_710,
  nightlyDebt: [
    { stayDate: '2026-07-27', amount: 508_355 },
    { stayDate: '2026-07-28', amount: 508_355 },
  ],
  pmsNote: 'AGD 1753026280_1STAN_2DEM 1.016.710 CN\nGIÁ KHÁCH ĐẶT 1.680.000 KHONG AN SANG',
  pmsNoteError: null,
};

describe('AgodaPartnerCard', () => {
  it('shows the operator-facing Agoda fields', () => {
    render(<AgodaPartnerCard agoda={EXTRAS} />);
    expect(screen.getByText('Đơn Agoda')).toBeInTheDocument();
    // No email framing: the operator only pastes text, there is no mail integration.
    expect(screen.queryByText(/email đối tác|Loại email/)).not.toBeInTheDocument();
    expect(screen.getByText('AGODA')).toBeInTheDocument();
    // "Khách sạn" is the configured branch ADDRESS, never the public KAS name.
    expect(screen.getByText('40-42 Bùi Thị Xuân')).toBeInTheDocument();
    expect(screen.queryByText('KAS Sonata Luxury Hotel')).not.toBeInTheDocument();
    expect(screen.getByText('1753026280')).toBeInTheDocument();
    expect(screen.getByText('TEST CUSTOMER')).toBeInTheDocument();
    // The date also appears in the per-night schedule, so scope to the field.
    expect(within(screen.getByText('Ngày nhận').closest('div')!).getByText('27/07/2026')).toBeInTheDocument();
    expect(screen.getByText('29/07/2026')).toBeInTheDocument();
    // Spec labels: Số đêm / Số phòng / Loại phòng / Mã phòng.
    expect(within(screen.getByText('Số đêm').closest('div')!).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByText('Số phòng').closest('div')!).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByText('Loại phòng').closest('div')!).getByText('Standard (0)')).toBeInTheDocument();
    expect(within(screen.getByText('Mã phòng').closest('div')!).getByText('STAN')).toBeInTheDocument();
    expect(screen.getByText('PREPAID')).toBeInTheDocument();
  });

  it('shows the exact two-line PMS note with a copy button', () => {
    render(<AgodaPartnerCard agoda={EXTRAS} />);
    const note = screen.getByText(/AGD 1753026280_1STAN_2DEM/);
    expect(note.textContent).toBe(
      'AGD 1753026280_1STAN_2DEM 1.016.710 CN\nGIÁ KHÁCH ĐẶT 1.680.000 KHONG AN SANG',
    );
    expect(screen.getByRole('button', { name: 'Sao chép PMS Note' })).toBeInTheDocument();
  });

  it('warns (and offers no note) when the room type is unknown', () => {
    render(
      <AgodaPartnerCard
        agoda={{
          ...EXTRAS,
          roomTypeOriginal: 'Penthouse Skyline Loft',
          roomCode: null,
          roomTypeKnown: false,
          pmsNote: null,
          pmsNoteError: 'Chưa đủ dữ liệu để tạo ghi chú Agoda: mã hạng phòng.',
        }}
      />,
    );
    expect(screen.getByText(/chưa có mã nội bộ/)).toBeInTheDocument();
    expect(screen.getByText(/Chưa đủ dữ liệu để tạo ghi chú Agoda/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sao chép PMS Note' })).not.toBeInTheDocument();
  });

  it('shows the total debt and the per-night debt schedule', () => {
    render(<AgodaPartnerCard agoda={EXTRAS} />);
    const total = screen.getByText('Tổng công nợ').closest('div')!;
    expect(within(total).getByText(/1\.016\.710/)).toBeInTheDocument();
    const schedule = screen.getByText('Giá công nợ từng đêm').parentElement!;
    expect(within(schedule).getByText('27/07/2026')).toBeInTheDocument();
    expect(within(schedule).getByText('28/07/2026')).toBeInTheDocument();
    expect(within(schedule).getAllByText(/508\.355/)).toHaveLength(2);
  });

  it('never shows Property ID, commission or tax rows', () => {
    const { container } = render(<AgodaPartnerCard agoda={EXTRAS} />);
    expect(container.textContent).not.toMatch(/245858|Property ID|Commission|Hoa hồng/i);
  });

  it('warns and asks for a manual branch when the hotel name is unresolved', () => {
    render(<AgodaPartnerCard agoda={{ ...EXTRAS, branchAddress: null, branchCode: null, branchId: null, sourceHotelName: 'KAS Luxury Hotel' }} />);
    expect(screen.getByText(/Không xác định được địa chỉ chi nhánh từ tên khách sạn Agoda/)).toBeInTheDocument();
    expect(screen.getByText(/chọn chi nhánh thủ công/)).toBeInTheDocument();
  });

  it('marks unreadable fields instead of inventing values', () => {
    render(<AgodaPartnerCard agoda={{ ...EXTRAS, netRate: null, totalDebtAmount: null, referenceSellRate: null, nightlyDebt: [], pmsNote: null, pmsNoteError: 'Thiếu Net rate.' }} />);
    const list = screen.getByText('Tổng công nợ').closest('div')!;
    expect(within(list).getByText('Không đọc được')).toBeInTheDocument();
  });
});
