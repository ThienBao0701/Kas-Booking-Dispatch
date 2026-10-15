/**
 * "BẬT THÔNG BÁO" — this device's Web Push subscription.
 *
 * Permission is asked ONLY from a press on "Bật thông báo", never on load (iOS
 * refuses anything else, and an unasked prompt is how permission gets denied for
 * good). The subscription is sent to the server, which files it under the
 * signed-in account — never under an account the browser names.
 *
 * iPhone / iPad receive Web Push only in the app added to the Home Screen; in
 * Safari itself the API is absent, and the bell says how to install instead.
 */
import { api } from '../api/client';

export type PushState = 'unsupported' | 'install-first' | 'unconfigured' | 'denied' | 'off' | 'on';

/** A step of "Bật thông báo" that failed, said in words the worker can act on. */
export class PushError extends Error {}

/** What "Gửi thông báo thử" reached — accepted by a push service is not yet shown on a phone. */
export interface TestPushResult {
  devices: number;
  sent: number;
  revoked: number;
  rejected: number;
  failed: number;
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function serverKey(): Promise<string | null> {
  return (await api.get<{ publicKey: string | null }>('/push/config')).publicKey;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  // No worker in development (and none until the app has loaded once).
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** Where this device stands — read without asking the user anything. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'install-first' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  // No worker yet (first load): "Bật thông báo" says so when pressed.
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/**
 * Asks for permission (from a press), subscribes, and registers the device.
 * Run again on load once it is on: no prompt then (permission is already
 * granted), and the server's copy is refreshed — re-attached to whoever is
 * signed in, revived if it had been revoked, renewed if the server key changed.
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'install-first' : 'unsupported';
  const key = await serverKey();
  if (!key) return 'unconfigured';
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  if (!(await registration())) {
    throw new PushError('Ứng dụng chưa sẵn sàng nhận thông báo. Hãy tải lại trang rồi bấm “Bật thông báo” lần nữa.');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key cannot be reused.
  const current = sub?.options.applicationServerKey;
  if (sub && current && btoa(String.fromCharCode(...new Uint8Array(current))) !== btoa(String.fromCharCode(...keyBytes(key)))) {
    await sub.unsubscribe();
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource });
  } catch {
    throw new PushError('Không đăng ký được thiết bị nhận thông báo. Kiểm tra kết nối mạng rồi thử lại.');
  }
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    await sub.unsubscribe().catch(() => undefined);
    throw new PushError('Trình duyệt trả về đăng ký không hợp lệ. Bấm “Bật thông báo” lần nữa.');
  }
  await api.post('/push/subscriptions', { endpoint: json.endpoint, keys: json.keys });
  return 'on';
}

/** "Gửi thông báo thử" — to this account's own registered devices. */
export function sendTestPush(): Promise<TestPushResult> {
  return api.post<TestPushResult>('/push/test');
}

/** Turns push off on this device — before signing out, or from the bell. */
export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api.del('/push/subscriptions', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}
