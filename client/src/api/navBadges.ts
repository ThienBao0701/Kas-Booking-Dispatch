import { api } from './client';

/**
 * Sidebar badge counts, all of them, in one payload.
 *
 * Every number is a `count(*)` the server runs against the same `where` as the
 * screen it labels — nothing here is cached in the browser, incremented by hand
 * or kept in component state, which is what makes a badge still correct after a
 * refresh, in a second tab, and after a claim, an expiry, a resend, a proof
 * submission, an approval, a rejection, a reminder being read or a chat reply.
 */
export interface NavBadgeCounts {
  new: number;
  pendingReview: number;
  rejected: number;
  resendOrders: number;
  chat: number;
  reminders: number;
}

export const navBadgesApi = {
  get: () => api.get<{ counts: NavBadgeCounts; serverNow: string }>('/nav-badges'),
};
