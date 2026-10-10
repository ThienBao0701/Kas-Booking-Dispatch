/**
 * OPERATIONAL NOTIFICATIONS — the in-app bell row and the device push, for the
 * three assignments that are worth interrupting someone for:
 *
 *   TECHNICAL_ASSIGNED     "Công việc kỹ thuật mới"      → the technician given the work
 *   HOUSEKEEPING_ASSIGNED  "Công việc buồng phòng mới"   → the worker given the rooms
 *   HOUSEKEEPING_RECLEAN   "Dọn lại phòng …"              → the worker given the re-clean
 *
 * ONE ACTION, ONE NOTIFICATION. Every notice carries the idempotency key of the
 * action that produced it (`dedupeKey`, unique in the database): a retried
 * request, a refresh or a re-render cannot create a second one, because reads
 * never create notifications at all and a repeated write is refused by the key.
 * A grouped assignment (three rooms at once) is ONE notice.
 *
 * ONE PUSH PER NOTIFICATION. The push is claimed (`pushedAt`) before it is sent,
 * so two dispatchers can never both send it. It goes to every live device of
 * the ONE account the notice is for — the recipient is decided by the
 * assignment on the server, never by the request.
 *
 * WITHOUT VAPID KEYS NOTHING IS PUSHED, and nothing breaks: the bell still shows
 * the notice, which is also the fallback when a device has push turned off.
 */
import type { NotificationKind, PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock } from '../lib/clock';
import { isPushServiceEndpoint, sendWebPush, validKeys, type SubscriptionKeys, type VapidKeys } from './webPush';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/** The server's VAPID keys from the environment, or null when push is not configured. */
export function vapidConfig(): VapidKeys | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost' };
}

/** What the browser needs to subscribe — the PUBLIC key only. */
export function pushClientConfig(): { publicKey: string | null } {
  return { publicKey: vapidConfig()?.publicKey ?? null };
}

/* ------------------------------------------------------------------ *
 * Subscriptions — always the authenticated account's
 * ------------------------------------------------------------------ */

export interface SubscriptionInput {
  endpoint: string;
  keys: SubscriptionKeys;
}

/**
 * Registers (or refreshes) this device for the signed-in account. The endpoint
 * is unique: a browser that registers under another login moves to that login,
 * so a shared phone stops receiving the previous user's work at once.
 */
export async function saveSubscription(userId: number, input: SubscriptionInput, userAgent: string | null) {
  if (!isPushServiceEndpoint(input.endpoint)) throw ApiError.validation('Địa chỉ nhận thông báo không hợp lệ.');
  if (!validKeys(input.keys)) throw ApiError.validation('Khóa nhận thông báo không hợp lệ.');
  const data = { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null };
  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: { endpoint: input.endpoint, ...data },
    update: { ...data, revokedAt: null },
    select: { id: true },
  });
  return { id: row.id };
}

/** Turns push off for this device — only the caller's own subscription can match. */
export async function removeSubscription(userId: number, endpoint: string): Promise<number> {
  return (await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } })).count;
}

/* ------------------------------------------------------------------ *
 * Notifying
 * ------------------------------------------------------------------ */

export interface OperationalNotice {
  userId: number;
  kind: NotificationKind;
  title: string;
  body: string;
  /** An in-app path, "/app/…". */
  link: string;
  /** The action's own identity: the same key twice is the same notification. */
  dedupeKey: string;
}

/**
 * Creates the bell rows (skipping any whose key already exists) and dispatches
 * their pushes. Returns the ids actually created.
 */
export async function notifyOperational(notices: OperationalNotice[], client: PrismaClient = prisma): Promise<string[]> {
  const ids: string[] = [];
  for (const notice of notices) {
    const { count } = await client.notification.createMany({ data: [notice], skipDuplicates: true });
    if (count === 0) continue;
    const row = await client.notification.findUnique({ where: { dedupeKey: notice.dedupeKey }, select: { id: true } });
    if (row) ids.push(row.id);
  }
  dispatchPush(ids, client);
  return ids;
}

/** Sends one message to one device; resolves to the push service's HTTP status. */
export type PushSender = (subscription: { endpoint: string } & SubscriptionKeys, payload: Buffer) => Promise<number>;

let senderOverride: PushSender | null = null;

/** Tests replace the network; production never calls this. */
export function setPushSender(sender: PushSender | null): void {
  senderOverride = sender;
}

function activeSender(): PushSender | null {
  if (senderOverride) return senderOverride;
  const vapid = vapidConfig();
  return vapid ? (subscription, payload) => sendWebPush(subscription, payload, vapid) : null;
}

const inFlight = new Set<Promise<unknown>>();

/**
 * Fire-and-forget: the assignment has already happened and answering it must
 * not wait on a phone's push service. Failures are logged, never thrown.
 */
export function dispatchPush(notificationIds: string[], client: PrismaClient = prisma): void {
  if (notificationIds.length === 0 || !activeSender()) return;
  for (const id of notificationIds) {
    const job: Promise<unknown> = pushNotification(id, client)
      // eslint-disable-next-line no-console
      .catch((err: unknown) => console.warn(`[push] notification ${id} not sent:`, err instanceof Error ? err.message : err))
      .finally(() => inFlight.delete(job));
    inFlight.add(job);
  }
}

/** Waits for every dispatched push to finish — for tests and graceful shutdown. */
export async function settlePushes(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/**
 * Pushes ONE notification to its account's devices, at most once. A device the
 * push service reports gone (404 / 410) is revoked; the account's other devices
 * are unaffected.
 */
export async function pushNotification(id: string, client: PrismaClient = prisma): Promise<{ sent: number; revoked: number }> {
  const send = activeSender();
  if (!send) return { sent: 0, revoked: 0 };
  const now = getClock().now();
  const claimed = await client.notification.updateMany({
    where: { id, pushedAt: null, kind: { not: null } },
    data: { pushedAt: now },
  });
  if (claimed.count === 0) return { sent: 0, revoked: 0 };
  const notice = await client.notification.findUniqueOrThrow({ where: { id } });
  const devices = await client.pushSubscription.findMany({ where: { userId: notice.userId, revokedAt: null } });
  const payload = Buffer.from(
    JSON.stringify({ title: notice.title, body: notice.body, url: notice.link ?? '/app', tag: `kas-${notice.id}` }),
  );
  let sent = 0;
  let revoked = 0;
  for (const device of devices) {
    try {
      const status = await send({ endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth }, payload);
      if (status === 404 || status === 410) {
        await client.pushSubscription.update({ where: { id: device.id }, data: { revokedAt: now } });
        revoked += 1;
      } else if (status >= 200 && status < 300) {
        await client.pushSubscription.update({ where: { id: device.id }, data: { lastUsedAt: now } });
        sent += 1;
      }
    } catch (err) {
      // A network failure on one device is not a reason to stop the others.
      // eslint-disable-next-line no-console
      console.warn(`[push] device ${device.id} unreachable:`, err instanceof Error ? err.message : err);
    }
  }
  return { sent, revoked };
}
