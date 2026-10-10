/**
 * Nhắc nhở — Admin → one receptionist.
 *
 * Deliberately separate from `notifications.ts`: notifications are
 * system-generated booking events, reminders are a person writing to a person.
 * Keeping the two clients apart keeps the two unread badges apart.
 */
import { api } from './client';

export interface ReminderActorView {
  id: number;
  fullName: string;
}

export interface ReminderView {
  id: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  read: boolean;
  sender: ReminderActorView | null;
  recipient: ReminderActorView | null;
}

/** The receptionist inbox polls at the same cadence as the order queue. */
export const REMINDER_POLL_MS = 20_000;

export const remindersApi = {
  /** Receptionist: their inbox. Admin: what they sent. Scoped server-side. */
  list: () => api.get<{ reminders: ReminderView[] }>('/reminders'),

  unreadCount: () => api.get<{ count: number }>('/reminders/unread-count'),

  /** ADMIN only. `recipientUserId` must be an active receptionist. */
  create: (recipientUserId: number, body: string) =>
    api.post<{ reminder: ReminderView }>('/reminders', { recipientUserId, body }),

  /**
   * ADMIN only. One reminder per active receptionist, at every branch.
   *
   * Same endpoint and same model as a single send — each recipient gets their
   * own row, so read state and unread badges keep working per person.
   */
  createForAllBranches: (body: string) =>
    api.post<{ recipients: number }>('/reminders', { recipientScope: 'ALL_BRANCHES', body }),

  /** Recipient only — another account's id simply matches no row. */
  markRead: (id: string) => api.post<{ reminder: ReminderView }>(`/reminders/${id}/read`, {}),
};
