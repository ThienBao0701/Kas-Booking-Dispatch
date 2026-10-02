import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installApiMock } from '../test/utils';
import { ProofComparisonCard } from './ProofComparisonCard';
import type { ComparisonResult, FieldComparison, NoteComponent } from '../api/compare';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LATEST = 'GET /api/admin/bookings/b1/proofs/p1/comparisons/latest';

function comparison(result: ComparisonResult) {
  return {
    id: 'c1', bookingId: 'b1', proofId: 'p1', analysisId: 'a1', overallStatus: result.overall,
    comparisonVersion: 'proof-compare-v1', result, errorMessage: null, createdAt: '2026-07-24T06:00:00.000Z',
  };
}

function result(over: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    overall: 'MISMATCH',
    version: 'proof-compare-v1',
    summary: { matchCount: 7, mismatchCount: 1, warningCount: 2, notFoundCount: 1 },
    fields: [],
    headline: 'Phát hiện thông tin không khớp cần Admin kiểm tra.',
    suggestions: ['Giá tổng', 'Trạng thái thanh toán'],
    noteComponents: [],
    ...over,
  };
}

function field(over: Partial<FieldComparison> = {}): FieldComparison {
  return { field: 'TOTAL_AMOUNT', label: 'Giá tổng', importance: 'CRITICAL', result: 'MISMATCH', expected: '4.720.680', detected: '4.270.680', message: 'Giá tổng trong ảnh không khớp.', ...over };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProofComparisonCard bookingId="b1" proofId="p1" />
    </QueryClientProvider>,
  );
}
function mount(r: ComparisonResult) {
  installApiMock({ [LATEST]: () => ({ status: 200, body: { comparison: comparison(r) } }) });
  renderCard();
}

describe('ProofComparisonCard smart — summary + headline', () => {
  it('renders the summary counts', async () => {
    mount(result());
    const list = await screen.findByLabelText('Tổng hợp đối chiếu');
    expect(within(list).getByText(/Khớp:/).closest('li')).toHaveTextContent('Khớp: 7');
    expect(within(list).getByText(/Sai khác:/).closest('li')).toHaveTextContent('Sai khác: 1');
    expect(within(list).getByText(/Không tìm thấy:/).closest('li')).toHaveTextContent('Không tìm thấy: 1');
  });
  it('renders the operational headline', async () => {
    mount(result());
    expect(await screen.findByText('Phát hiện thông tin không khớp cần Admin kiểm tra.')).toBeInTheDocument();
  });
});

describe('ProofComparisonCard smart — field explanations', () => {
  it('money delta explanation renders', async () => {
    mount(result({ fields: [field({ explanation: 'Ảnh thấp hơn dữ liệu Admin 450.000 đ.', details: { deltaAmount: -450_000 } })] }));
    expect(await screen.findByText('Ảnh thấp hơn dữ liệu Admin 450.000 đ.')).toBeInTheDocument();
  });
  it('date delta explanation renders', async () => {
    mount(result({ fields: [field({ field: 'CHECK_IN', label: 'Check-in', explanation: 'Ngày trong ảnh trễ hơn 1 ngày.' })] }));
    expect(await screen.findByText('Ngày trong ảnh trễ hơn 1 ngày.')).toBeInTheDocument();
  });
  it('night difference explanation renders', async () => {
    mount(result({ overall: 'WARNING', fields: [field({ field: 'NIGHTS', label: 'Số đêm', result: 'WARNING', explanation: 'Thiếu 1 đêm.' })] }));
    expect(await screen.findByText('Thiếu 1 đêm.')).toBeInTheDocument();
  });
  it('room quantity difference explanation renders', async () => {
    mount(result({ fields: [field({ field: 'ROOM_QUANTITY', label: 'Số lượng phòng', explanation: 'Thiếu 1 phòng.' })] }));
    expect(await screen.findByText('Thiếu 1 phòng.')).toBeInTheDocument();
  });
  it('booking-code changed character renders', async () => {
    mount(result({ fields: [field({ field: 'BOOKING_CODE', label: 'Mã Booking', explanation: 'Sai 1 ký tự tại vị trí cuối: 4 → 8' })] }));
    expect(await screen.findByText('Sai 1 ký tự tại vị trí cuối: 4 → 8')).toBeInTheDocument();
  });
  it('token diff renders added and removed segments with accessible text', async () => {
    mount(result({ fields: [field({ field: 'ROOM_TYPE', label: 'Hạng phòng', result: 'MISMATCH', diffSegments: [
      { text: 'Superior', op: 'unchanged' }, { text: 'Deluxe', op: 'added' }, { text: 'Double', op: 'unchanged' },
    ] })] }));
    const added = await screen.findByText('Deluxe');
    expect(added.className).toContain('underline');
    expect(added).toHaveTextContent('(thêm)'); // screen-reader wording present
  });
  it('a suggestion is shown per non-matching field', async () => {
    mount(result({ fields: [field({ suggestion: 'Đối chiếu lại giá tổng.' })] }));
    expect(await screen.findByText('Khuyến nghị: Đối chiếu lại giá tổng.')).toBeInTheDocument();
  });
});

describe('ProofComparisonCard smart — confidence labels', () => {
  it.each<[NonNullable<FieldComparison['confidenceLabel']>, string]>([
    ['HIGH', 'Độ tin cậy cao'],
    ['MEDIUM', 'Độ tin cậy trung bình'],
    ['LOW', 'Độ tin cậy thấp'],
  ])('%s → %s', async (confidenceLabel, text) => {
    mount(result({ overall: 'MATCH', fields: [field({ result: 'MATCH', confidenceLabel })] }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});

describe('ProofComparisonCard smart — suggestions + note checklist', () => {
  it('renders a de-duplicated "Admin nên kiểm tra" list', async () => {
    mount(result({ suggestions: ['Giá tổng', 'Trạng thái thanh toán', 'Giờ đến trong ghi chú'] }));
    const box = await screen.findByText('Admin nên kiểm tra');
    const list = box.parentElement!.querySelector('ul')!;
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Giá tổng')).toBeInTheDocument();
  });
  it('renders the PMS note checklist with matched + missing components', async () => {
    const noteComponents: NoteComponent[] = [
      { key: 'BOOKING_CODE', label: 'Mã Booking', result: 'MATCH' },
      { key: 'CI', label: 'CI', result: 'MATCH' },
      { key: 'ARRIVAL_NOTE', label: 'Giờ đến', result: 'NOT_FOUND' },
    ];
    mount(result({ noteComponents }));
    const list = await screen.findByLabelText('Thành phần PMS Note');
    expect(within(list).getByText('Mã Booking')).toBeInTheDocument();
    const arrival = within(list).getByText('Giờ đến').closest('li')!;
    expect(within(arrival).getByText(/chưa tìm thấy/)).toBeInTheDocument(); // accessible text
  });
});

describe('ProofComparisonCard smart — compact match rows', () => {
  it('a MATCH row does not show a suggestion', async () => {
    mount(result({ overall: 'MATCH', fields: [field({ result: 'MATCH', expected: '4.720.680', detected: '4.720.680', message: 'Giá tổng khớp.' })] }));
    await screen.findByRole('table');
    expect(screen.queryByText(/Khuyến nghị:/)).not.toBeInTheDocument();
  });
  it('legacy C.3 comparison (no smart fields) still renders base rows', async () => {
    // No headline/suggestions/noteComponents/details — a stored proof-compare-v1 row.
    mount({ overall: 'MISMATCH', version: 'proof-compare-v1', summary: { matchCount: 0, mismatchCount: 1, warningCount: 0, notFoundCount: 0 }, fields: [field()] });
    expect(await screen.findByText('Giá tổng trong ảnh không khớp.')).toBeInTheDocument();
    expect(screen.queryByText('Admin nên kiểm tra')).not.toBeInTheDocument();
  });
});
