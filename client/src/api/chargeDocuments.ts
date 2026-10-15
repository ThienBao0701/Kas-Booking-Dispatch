/**
 * The Chứng từ API client.
 *
 * NOTE WHAT IS ABSENT: `ChargeDocumentView` has no field for a full card
 * number. The server never sends one outside the reveal call, and the type says
 * so — a component cannot accidentally render a PAN it was never given.
 *
 * The revealed number is returned by one function, is never written to
 * localStorage or sessionStorage, never appears in a URL, and is held only in
 * component state for as long as the operator is looking at it.
 */
import { api } from './client';

export type ChargeStatus = 'CHUA_XU_LY' | 'DA_BI_CHARGE' | 'CHARGE_THAT_BAI';

/** The operator's words. Mirrors server/src/charge/chargeStatus.ts. */
export const CHARGE_STATUS_LABEL: Record<ChargeStatus, string> = {
  CHUA_XU_LY: 'Chưa xử lý',
  DA_BI_CHARGE: 'Đã bị charge',
  CHARGE_THAT_BAI: 'Charge thất bại',
};

export const CHARGE_STATUSES: ChargeStatus[] = ['CHUA_XU_LY', 'DA_BI_CHARGE', 'CHARGE_THAT_BAI'];

/** Tone for the status chip, following the app's existing badge vocabulary. */
export const CHARGE_STATUS_TONE: Record<ChargeStatus, string> = {
  CHUA_XU_LY: 'bg-slate-100 text-slate-700',
  DA_BI_CHARGE: 'bg-green-100 text-green-700',
  CHARGE_THAT_BAI: 'bg-red-100 text-red-700',
};

export type ChargeAttachmentCategory = 'GUEST_IMAGE' | 'CHARGE_DOCUMENT' | 'CARD_IMAGE';

export const ATTACHMENT_CATEGORY_LABEL: Record<ChargeAttachmentCategory, string> = {
  GUEST_IMAGE: 'Ảnh khách',
  CHARGE_DOCUMENT: 'File chứng từ',
  CARD_IMAGE: 'Ảnh mã thẻ',
};

export interface ChargeAttachmentView {
  id: string;
  category: ChargeAttachmentCategory;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: string;
  uploadedBy: { id: number; fullName: string } | null;
}

export interface ChargeDocumentView {
  id: string;
  branch: { id: number; code: string; branchNumber: number; hotelName: string; address: string };
  bookingId: string | null;
  guestName: string;
  bookingCode: string;
  amount: number;
  /** The last four digits — the most this type will ever carry. */
  cardLast4: string;
  /** "•••• 1234", ready to render. */
  cardMasked: string;
  cardExpiry: string;
  checkIn: string;
  checkOut: string;
  reason: string;
  status: ChargeStatus;
  chargedAt: string | null;
  createdBy: { id: number; fullName: string } | null;
  updatedBy: { id: number; fullName: string } | null;
  createdAt: string;
  updatedAt: string;
  attachments: ChargeAttachmentView[];
}

export interface ChargeAuditEvent {
  id: string;
  action: 'CREATED' | 'UPDATED' | 'STATUS_CHANGED' | 'ATTACHMENT_ADDED' | 'ATTACHMENT_REMOVED' | 'CARD_REVEALED';
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  actor: { id: number; fullName: string } | null;
  actorRole: string | null;
  createdAt: string;
}

export const CHARGE_AUDIT_LABEL: Record<ChargeAuditEvent['action'], string> = {
  CREATED: 'Tạo chứng từ',
  UPDATED: 'Chỉnh sửa',
  STATUS_CHANGED: 'Đổi trạng thái',
  ATTACHMENT_ADDED: 'Thêm tệp',
  ATTACHMENT_REMOVED: 'Xoá tệp',
  CARD_REVEALED: 'Xem số thẻ',
};

export interface MonthlyChargeReport {
  month: string;
  from: string;
  to: string;
  totals: {
    documentCount: number;
    chargedCount: number;
    chargedAmount: number;
    failedCount: number;
    failedAmount: number;
    pendingCount: number;
    pendingAmount: number;
  };
  rows: ChargeDocumentView[];
}

export interface ChargeDocumentInput {
  branchId: number;
  guestName: string;
  bookingCode: string;
  amount: number;
  cardNumber: string;
  cardExpiry: string;
  checkIn: string;
  checkOut: string;
  reason: string;
  status?: ChargeStatus;
}

export interface ChargeListFilters {
  branchId?: number;
  status?: ChargeStatus;
  chargedFrom?: string;
  chargedTo?: string;
  checkInFrom?: string;
  checkInTo?: string;
  guestName?: string;
  bookingCode?: string;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The authenticated URL an attachment's bytes are fetched from. Never public. */
export function attachmentUrl(attachmentId: string): string {
  return `/api/charge-documents/attachments/${attachmentId}/file`;
}

export const chargeDocumentsApi = {
  list: (filters: ChargeListFilters = {}) =>
    api.get<{ documents: ChargeDocumentView[] }>(`/charge-documents${query({ ...filters })}`),

  detail: (id: string) => api.get<{ document: ChargeDocumentView }>(`/charge-documents/${id}`),

  create: (input: ChargeDocumentInput) =>
    api.post<{ document: ChargeDocumentView }>('/charge-documents', input),

  update: (id: string, patch: Partial<ChargeDocumentInput>) =>
    api.put<{ document: ChargeDocumentView }>(`/charge-documents/${id}`, patch),

  audit: (id: string) => api.get<{ events: ChargeAuditEvent[] }>(`/charge-documents/${id}/audit`),

  /**
   * Reveals the full card number.
   *
   * A POST so the number can never end up in a URL, a history entry or an
   * access log. The server audits every call.
   */
  revealCard: (id: string) => api.post<{ cardNumber: string }>(`/charge-documents/${id}/card`),

  uploadAttachments: (id: string, category: ChargeAttachmentCategory, files: File[]) => {
    const form = new FormData();
    form.append('category', category);
    for (const file of files) form.append('files', file);
    return api.postForm<{ document: ChargeDocumentView; added: number }>(
      `/charge-documents/${id}/attachments`,
      form,
    );
  },

  removeAttachment: (attachmentId: string) =>
    api.del<{ success: true }>(`/charge-documents/attachments/${attachmentId}`),

  report: (month: string) =>
    api.get<{ report: MonthlyChargeReport }>(`/charge-documents/report${query({ month })}`),

  /** The XLSX download URL. Same query, same server-side report. */
  exportUrl: (month: string) => `/api/charge-documents/report/export${query({ month })}`,
};
