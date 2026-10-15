import { api } from './client';

export interface NotificationItem {
  id: string;
  bookingId: string | null;
  /** Where a press goes — an in-app path ("/app/…"); null on older rows. */
  link: string | null;
  kind: 'TECHNICAL_ASSIGNED' | 'HOUSEKEEPING_ASSIGNED' | 'HOUSEKEEPING_RECLEAN' | null;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsResponse {
  notifications: NotificationItem[];
  unreadCount: number;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export const notificationsApi = {
  list: (page = 1, pageSize = 20) =>
    api.get<NotificationsResponse>(`/notifications?page=${page}&pageSize=${pageSize}`),
  unreadCount: () => api.get<{ count: number }>('/notifications/unread-count'),
  markRead: (id: string) => api.post<{ success: true }>(`/notifications/${id}/read`),
  markAllRead: () => api.post<{ updated: number }>('/notifications/read-all'),
};
