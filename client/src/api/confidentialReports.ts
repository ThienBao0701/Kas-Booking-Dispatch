import { api } from './client';

export type ConfidentialCategory = 'WORK_ENVIRONMENT' | 'PROCESS_RULES' | 'COLLEAGUES' | 'OTHER_IMPORTANT';

export interface ConfidentialRecipient {
  id: number;
  fullName: string;
  role: string;
  roleLabel: string;
}

export interface ConfidentialOptions {
  title: string;
  categories: { code: ConfidentialCategory; label: string }[];
  /** Whether this account reports upward (Lễ tân, Quản lý lễ tân, Tổng quản lý). */
  canSend: boolean;
  /** Whether this account has an inbox (the managers and the Admin). */
  canRead: boolean;
  /** The superiors THIS account may choose — the server's list; the Admin is always added. */
  recipients: ConfidentialRecipient[];
}

export interface ConfidentialReport {
  id: string;
  category: ConfidentialCategory;
  categoryLabel: string;
  sender: { id: number; name: string; role: string; roleLabel: string };
  branch: { id: number; branchNumber: number; address: string } | null;
  createdAt: string;
  preview: string;
  /** Present on the opened report only. */
  content?: string;
  recipients: { id: number; name: string; roleLabel: string }[];
  /** THIS reader's state. */
  read: boolean;
  readAt: string | null;
}

export const confidentialApi = {
  options: () => api.get<ConfidentialOptions>('/confidential-reports/options'),
  send: (input: { category: ConfidentialCategory; content: string; recipientIds: number[] }) =>
    api.post<{ report: { id: string; createdAt: string } }>('/confidential-reports', input),
  inbox: (state?: 'UNREAD' | 'READ') =>
    api.get<{ reports: ConfidentialReport[]; counts: { unread: number; read: number } }>(
      `/confidential-reports${state ? `?state=${state}` : ''}`,
    ),
  open: (id: string) => api.post<{ report: ConfidentialReport }>(`/confidential-reports/${id}/read`),
};
